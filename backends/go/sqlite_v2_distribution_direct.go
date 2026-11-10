package querytable

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// directDistributions reduces distributions of a stored number field, grouped
// by stored text/enum/bool fields, in one native scan of the matching
// population shared by every such metric. Compiled distribution plans would
// copy the population through validation stages and sort it once per metric.
// Rows reach the in-memory reducers as their SQLite storage values; the
// request's and each metric's filters stay in SQL. Values the reducers cannot
// read exactly (errRowsUnsupported) or a failed statement leave every metric
// to its compiled plan: ok is false. total is the matching population.
// The scan retains every sample of its metrics: it admits metrics in request
// order while the counted population times their number stays within
// sqliteDirectSamples, and leaves the rest to their compiled plans.
func (d sqliteV2Dataset) directDistributions(ctx context.Context, tx *sql.Tx, q metricRequest, failures []error, o PlanOptions, maxGroups, maxPopulation int, counted int64) (metrics map[int]MetricResult, total int64, ok bool, err error) {
	include := make([]bool, len(q.Metrics))
	selected, retained := false, int64(0)
	fields := map[string]bool{}
	for i, spec := range q.Metrics {
		if failures[i] != nil || spec.Distribution == nil || rowMetricComputedField(spec) != "" {
			continue
		}
		m, e := rowMetricShape(spec, d.Schema, sqliteDirectBinding)
		if e != nil {
			continue
		}
		// Admit metrics while their samples fit; the rest run compiled plans.
		if retained+counted > sqliteDirectSamples {
			continue
		}
		include[i], selected = true, true
		retained += counted
		fields[m.field] = true
		for _, name := range spec.GroupBy {
			fields[name] = true
		}
	}
	if !selected {
		return nil, 0, false, nil
	}
	sourceName := "qt_direct_source"
	for strings.Contains(strings.ToLower(d.SourceSQL), sourceName) {
		sourceName += "_"
	}
	args := append([]any{}, d.SourceArgs...)
	// The source precedes every numbered parameter, as in compiled plans.
	statement := "WITH " + sourceName + " AS NOT MATERIALIZED (SELECT * FROM (" + d.SourceSQL + ") AS r) SELECT "
	names := []string{}
	projections := []string{}
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		// Unary plus keeps the stored value but drops the declared type, which
		// some drivers use to convert values (for example to time.Time).
		projections = append(projections, "+("+d.Schema.Fields[name].Expr+")")
	}
	flags := map[string]int{}
	var flagErr error
	whereFlag := func(where []WhereTerm) int {
		if len(where) == 0 {
			return -1
		}
		key, _ := json.Marshal(where)
		if i, ok := flags[string(key)]; ok {
			return i
		}
		filter, _, e := compileSQLiteWhere(where, d.Schema, sqliteOptions{Now: o.Now}, o.relations)
		if e != nil || filter.SQL == "" {
			// Blank literals match every row. A filter error leaves every
			// metric to its compiled plan, which reports it.
			flagErr = errors.Join(flagErr, e)
			return -1
		}
		projections = append(projections, "CASE WHEN "+sqliteNumberParameters(filter.SQL, len(args))+" THEN 1 ELSE 0 END")
		args = append(args, filter.Args...)
		flags[string(key)] = len(flags)
		return len(flags) - 1
	}
	reducer, err := newRowMetrics(ctx, q, d.Schema, o, failures, maxGroups, rowMetricsOptions{include: include, bound: sqliteDirectBinding, whereFlag: whereFlag})
	if err != nil || flagErr != nil {
		return nil, 0, false, ctx.Err()
	}
	filter, _, err := compileSQLiteWhere(q.Where, d.Schema, sqliteOptions{Now: o.Now}, o.relations)
	if err != nil {
		// Like a metric filter, a population filter the stored-field scan cannot
		// read (such as a computed field) leaves every metric to its compiled plan.
		return nil, 0, false, ctx.Err()
	}
	statement += strings.Join(projections, ",") + " FROM " + sourceName + " AS r"
	if filter.SQL != "" {
		statement += " WHERE " + sqliteNumberParameters(filter.SQL, len(args))
		args = append(args, filter.Args...)
	}
	statement += fmt.Sprintf(" LIMIT %d", maxPopulation+1)
	rows, err := tx.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, 0, false, ctx.Err()
	}
	defer rows.Close()
	values := make([]any, len(projections))
	targets := make([]any, len(values))
	for i := range values {
		targets[i] = &values[i]
	}
	row := make(map[string]any, len(names))
	matches := make([]bool, len(flags))
	for rows.Next() {
		if err = rows.Scan(targets...); err != nil {
			return nil, 0, false, ctx.Err()
		}
		total++
		if total > int64(maxPopulation) {
			return nil, 0, false, diagnostic(ErrorCodeResourceLimit, "matching population exceeds host budget")
		}
		for i, name := range names {
			row[name] = values[i]
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
		return nil, 0, false, ctx.Err()
	}
	result, err := reducer.finish(total)
	if err != nil {
		return nil, 0, false, err
	}
	metrics = map[int]MetricResult{}
	for i, m := range result.Metrics {
		if include[i] {
			metrics[i] = m
		}
	}
	return metrics, total, true, nil
}

// sqliteDirectSamples bounds the samples the direct scan retains in memory
// (eight bytes each) across its metrics.
const sqliteDirectSamples = 1000000

// sqliteDirectBinding admits fields whose SQL value is their stored value.
func sqliteDirectBinding(name string, f FieldSpec) bool {
	return !strings.HasPrefix(name, "@computed/") && !f.Synthetic && f.ValueErrorExpr == "" && strings.TrimSpace(f.Expr) != ""
}
