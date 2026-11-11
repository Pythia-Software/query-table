package querytable

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// sqliteSharedMetrics reads an eligible dashboard population once, including
// its total. Cohorts share aggregate state by grouping and clause filter;
// percentiles of the same input share samples and their sort. Calendar keys
// are computed once per configuration per row, without a scratch relation.
//
// This is speculative only over proved stored sources. Unsupported shapes,
// storage or memory requirements decline the entire batch to the SQL executor,
// which retains its diagnostics and budget precedence. No host expression is
// evaluated by a failed speculation. Rows and host population counters keep
// their existing execution paths.
func (d QueryDatasetV3) sqliteSharedMetrics(ctx context.Context, tx *sql.Tx, request QueryRequestV3, o PlanOptions, maxGroups int) ([]MetricResult, int64, bool, error) {
	if d.Dialect != "sqlite" || request.Rows || len(request.Metrics) < 2 || d.PopulationCounter != nil || sqliteTextDistinctPreferSQL(request, d.Schema) {
		return nil, 0, false, nil
	}
	// Existing SQL fusion is cheaper for scalar clauses with one population,
	// and distribution-only batches already share a native scan. Use this
	// path for mixed reductions, grouping sets, filters, or calendar clauses.
	populations := map[string]bool{}
	hasScalar, hasDistribution, hasCalendar := false, false, false
	for _, spec := range request.Metrics {
		key, _ := json.Marshal(struct {
			Groups []string
			Where  []WhereTerm
		}{spec.GroupBy, spec.Where})
		populations[string(key)] = true
		hasScalar = hasScalar || spec.Distribution == nil
		hasDistribution = hasDistribution || spec.Distribution != nil
		hasCalendar = hasCalendar || spec.DateGrouping != nil
	}
	if !hasCalendar && (!hasScalar || !hasDistribution && len(populations) == 1) {
		return nil, 0, false, nil
	}
	q := metricRequest{Version: 2, Where: request.Result.Where, Limit: request.Result.Limit, Offset: request.Result.Offset, OrderBy: request.Result.OrderBy, Metrics: append([]AggSpec{}, request.Metrics...)}
	s := d.Schema
	s.Fields = make(map[string]FieldSpec, len(d.Schema.Fields))
	for name, field := range d.Schema.Fields {
		s.Fields[name] = field
	}
	fields := map[string]bool{}
	proof := []string{}
	calendars := []*sharedMetricCalendar{}
	calendarByKey := map[string]*sharedMetricCalendar{}
	for i, spec := range q.Metrics {
		// SQLite's window SUM for Other uses its own floating accumulator.
		// Preserve those exact bits through the existing consumer.
		if spec.GroupLimit > 0 && metricOtherShape(spec).plain == "SUM" {
			return nil, 0, false, nil
		}
		plain := spec
		plain.DateGrouping = nil
		// Compile every original clause before reducing it: authorization,
		// aggregate policies, filters, sorts and types stay compiler-owned.
		p, err := compileMetricDialect(ctx, q, plain, d.Schema, o, true)
		if err != nil {
			return nil, 0, false, ctx.Err()
		}
		proof = append(proof, p.Dependencies...)
		if config := spec.DateGrouping; config != nil {
			for _, name := range p.Dependencies {
				fields[name] = true
			}
			field := s.Fields[config.Field]
			if config.IncludeEmpty || spec.Distribution != nil || field.Kind != FieldDatetime || !fieldGroupable(field) || !sqliteDirectBinding(config.Field, field) || len(spec.GroupBy) == 0 || spec.GroupBy[0] != config.Field {
				return nil, 0, false, nil
			}
			loc, err := calendarLocation(*config)
			if err != nil {
				return nil, 0, false, nil
			}
			key, _ := json.Marshal(*config)
			calendar := calendarByKey[string(key)]
			if calendar == nil {
				name := fmt.Sprintf("__qt_shared_calendar_%d__", len(calendars))
				if _, exists := s.Fields[name]; exists {
					return nil, 0, false, nil
				}
				calendar = &sharedMetricCalendar{config: *config, loc: loc, name: name}
				calendars = append(calendars, calendar)
				calendarByKey[string(key)] = calendar
				s.Fields[name] = resultField(name, "text", "r."+queryIdent(name), true)
			}
			fields[config.Field] = true
			plain.GroupBy = append([]string{}, spec.GroupBy...)
			plain.GroupBy[0] = calendar.name
			plain.GroupLimit, plain.Sort = 0, nil // calendar ordering follows reduction
			q.Metrics[i] = plain
		}
		m, err := rowMetricShape(q.Metrics[i], s, sqliteDirectBinding)
		if err != nil || rowMetricComputedField(spec) != "" {
			return nil, 0, false, nil
		}
		if m.field != "" {
			fields[m.field] = true
		}
		if name := spec.MinCount.field(); name != "" {
			fields[name] = true
		}
		for _, name := range spec.GroupBy {
			fields[name] = true
		}
		for _, term := range spec.Where {
			for _, predicate := range term.Predicates() {
				proof = append(proof, predicate.Field)
			}
		}
	}
	if len(calendars) > 0 {
		fields[s.IDField] = true
	}
	names := []string{}
	for name := range fields {
		if !sqliteDirectBinding(name, s.Fields[name]) {
			return nil, 0, false, nil
		}
		names = append(names, name)
	}
	sort.Strings(names)
	proof = append(proof, names...)
	for _, term := range q.Where {
		for _, predicate := range term.Predicates() {
			proof = append(proof, predicate.Field)
		}
	}
	sort.Strings(proof)
	proof = uniqueStrings(proof)
	// Prove only the host's bindings. Request predicates are our own compiled
	// expressions (including datetime conversion), not opaque host SQL.
	stored, err := d.sqliteStoredFields(ctx, tx, proof, nil, o)
	if err != nil || !stored {
		return nil, 0, false, err
	}
	args := append([]any{}, d.SourceArgs...)
	// SQLite assigns anonymous source placeholders in textual order. Keep the
	// source ahead of the numbered clause-filter parameters in SELECT, as the
	// compiled executor and direct distribution scan do.
	sourceName := "qt_shared_source"
	for strings.Contains(strings.ToLower(d.SourceSQL), sourceName) {
		sourceName += "_"
	}
	projections := []string{}
	for _, name := range names {
		projections = append(projections, "+("+s.Fields[name].Expr+")")
	}
	flags := map[string]int{}
	var flagErr error
	whereFlag := func(where []WhereTerm) int {
		if len(where) == 0 {
			return -1
		}
		key, _ := json.Marshal(where)
		if index, ok := flags[string(key)]; ok {
			return index
		}
		filter, _, e := compileSQLiteWhere(where, d.Schema, sqliteOptions{Now: o.Now}, o.relations)
		if e != nil {
			flagErr = e
			return -1
		}
		if filter.SQL == "" {
			return -1
		}
		projections = append(projections, "CASE WHEN "+sqliteNumberParameters(filter.SQL, len(args))+" THEN 1 ELSE 0 END")
		args = append(args, filter.Args...)
		flags[string(key)] = len(flags)
		return len(flags) - 1
	}
	sampleLimit, _ := d.sampleLimit()
	reducer, err := newRowMetrics(ctx, q, s, o, make([]error, len(q.Metrics)), maxGroups, rowMetricsOptions{bound: sqliteDirectBinding, whereFlag: whereFlag, sampleLimit: sampleLimit, maxRetained: 128 << 20})
	if err != nil || flagErr != nil {
		return nil, 0, false, ctx.Err()
	}
	filter, _, err := compileSQLiteWhere(q.Where, d.Schema, sqliteOptions{Now: o.Now}, o.relations)
	if err != nil {
		return nil, 0, false, ctx.Err()
	}
	// COUNT-only cohorts still need one projected column to stream their rows.
	if len(projections) == 0 {
		projections = append(projections, "1")
	}
	statement := "WITH " + sourceName + " AS NOT MATERIALIZED (" + d.SourceSQL + ") SELECT " + strings.Join(projections, ",") + " FROM " + sourceName + " AS r"
	if filter.SQL != "" {
		statement += " WHERE " + sqliteNumberParameters(filter.SQL, len(args))
		args = append(args, filter.Args...)
	}
	scanError := func(err error) ([]MetricResult, int64, bool, error) {
		// A clause filter may throw while opening the cursor or advancing it.
		// Its error cannot be attributed inside the shared statement. Discard
		// speculation and let the original executor count the population and
		// isolate each clause. Cancellation and request diagnostics still fail.
		if len(flags) > 0 {
			if _, _, clause := metricClauseError(ctx, err); clause {
				return nil, 0, false, nil
			}
		}
		return nil, 0, false, err
	}
	rows, err := tx.QueryContext(ctx, statement, args...)
	if err != nil {
		return scanError(err)
	}
	defer rows.Close()
	values := make([]any, len(projections))
	targets := make([]any, len(values))
	for i := range values {
		targets[i] = &values[i]
	}
	row := make(map[string]any, len(names)+len(calendars))
	matches := make([]bool, len(flags))
	_, _, maxPopulation, maxBytes, _ := d.limits()
	var total, calendarBytes int64
	for rows.Next() {
		if err = rows.Scan(targets...); err != nil {
			return scanError(err)
		}
		total++
		if total%256 == 0 {
			if err = ctx.Err(); err != nil {
				return nil, 0, false, err
			}
		}
		if total > sqliteDirectPopulation {
			return nil, 0, false, nil
		}
		for i, name := range names {
			row[name] = values[i]
			field := s.Fields[name]
			if field.Kind == FieldDatetime && (field.SQLiteDatetimeFormat == "unix-millis" || field.SQLiteDatetimeFormat == "unix-seconds") && values[i] == "" {
				return nil, 0, false, nil
			}
		}
		if len(calendars) > 0 {
			// An upper bound on each clause's narrow typed calendar payload:
			// all scanned fields plus its ordinal and canonical key. If this
			// cannot prove the original budget, let SQL perform the exact check.
			calendarBytes += 8 + 24
			for _, name := range names {
				if row[name] == nil {
					continue
				}
				switch value := row[name].(type) {
				case string:
					calendarBytes += int64(max(len(value), 32))
				default:
					calendarBytes += 32
				}
			}
			if total > int64(maxPopulation) || calendarBytes > maxBytes {
				return nil, 0, false, nil
			}
			for _, calendar := range calendars {
				field := s.Fields[calendar.config.Field]
				value, e := rowStorage(row[calendar.config.Field], &field)
				if e != nil {
					return nil, 0, false, nil
				}
				if value == nil {
					row[calendar.name] = nil
					continue
				}
				instant, code := sqliteV2DatetimeInstant(value, field.SQLiteDatetimeFormat)
				if code != "" {
					return nil, 0, false, nil
				}
				if calendar.key == "" || instant.Before(calendar.start) || !instant.Before(calendar.next) {
					floor, e := calendarFloorEvery(instant, calendar.config.Interval, calendar.config.Every, calendar.loc)
					if e != nil {
						return nil, 0, false, nil
					}
					calendar.start = floor
					calendar.next, e = calendarNextEvery(floor, calendar.config.Interval, calendar.config.Every, calendar.loc)
					if e != nil {
						return nil, 0, false, nil
					}
					calendar.key = floor.UTC().Format("2006-01-02T15:04:05.000Z")
					if calendarCycle(calendar.config.Interval) {
						calendar.key = strconv.Itoa(calendarSlot(floor, calendar.config.Interval, calendar.loc))
					}
				}
				row[calendar.name] = calendar.key
			}
		}
		for i := range matches {
			flag, _ := values[len(names)+i].(int64)
			matches[i] = flag == 1
		}
		if err = reducer.add(row, matches); err != nil {
			if errors.Is(err, errRowsUnsupported) {
				return nil, 0, false, nil
			}
			return nil, 0, false, err
		}
	}
	if err = rows.Err(); err != nil {
		return scanError(err)
	}
	result, err := reducer.finish(total)
	if err != nil {
		return nil, 0, false, err
	}
	for i, spec := range request.Metrics {
		if spec.DateGrouping == nil || result.Metrics[i].Error != "" {
			continue
		}
		metric := &result.Metrics[i]
		if calendarCycle(spec.DateGrouping.Interval) {
			for j := range metric.Buckets {
				if key, ok := metric.Buckets[j].Keys[0].(string); ok {
					n, _ := strconv.Atoi(key)
					metric.Buckets[j].Keys[0] = float64(n)
				}
			}
		}
		sortCalendarBuckets(metric.Buckets, spec)
		if spec.GroupLimit > 0 && len(metric.Buckets) > spec.GroupLimit {
			shape := metricOtherShape(spec)
			metric.Other = shape.remainder(spec, otherSumsFromBuckets(metric.Buckets[spec.GroupLimit:], len(shape.columns())))
			metric.Buckets = metric.Buckets[:spec.GroupLimit]
		}
	}
	return result.Metrics, total, true, ctx.Err()
}

type sharedMetricCalendar struct {
	config      MetricDateGrouping
	loc         *time.Location
	name, key   string
	start, next time.Time
}
