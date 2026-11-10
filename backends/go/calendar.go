package querytable

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var calendarDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$`)

func calendarLocation(config MetricDateGrouping) (*time.Location, error) {
	zone := config.TimeZone
	if zone == "" {
		zone = "UTC"
	}
	if len(zone) > 80 || strings.HasPrefix(zone, "+") || strings.HasPrefix(zone, "-") {
		return nil, diagnostic(ErrorCodeDateGrouping, "use an IANA grouping timezone")
	}
	if !containsString([]string{"hour", "day", "week", "month", "year", "hourOfDay", "dayOfWeek"}, config.Interval) || !containsString([]string{"query", "observed", "custom"}, config.Range) || config.Field == "" || len(config.Field) > 256 {
		return nil, diagnostic(ErrorCodeDateGrouping, "invalid date grouping definition")
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return nil, diagnostic(ErrorCodeDateGrouping, "use an IANA grouping timezone")
	}
	return location, nil
}

// calendarCycle reports whether an interval is cyclic: keyed by slot number.
func calendarCycle(interval string) bool {
	return interval == "hourOfDay" || interval == "dayOfWeek"
}

// calendarUnit is the calendar interval one occurrence of a cyclic slot spans.
func calendarUnit(interval string) string {
	switch interval {
	case "hourOfDay":
		return "hour"
	case "dayOfWeek":
		return "day"
	}
	return interval
}

// calendarSlots lists every slot of a cyclic interval in order.
func calendarSlots(interval string) []float64 {
	if interval == "hourOfDay" {
		slots := make([]float64, 24)
		for i := range slots {
			slots[i] = float64(i)
		}
		return slots
	}
	return []float64{1, 2, 3, 4, 5, 6, 7}
}

// calendarSlot is the local hour or ISO weekday of an instant.
func calendarSlot(instant time.Time, interval string, loc *time.Location) int {
	local := instant.In(loc)
	if interval == "hourOfDay" {
		return local.Hour()
	}
	return (int(local.Weekday())+6)%7 + 1
}

func calendarLocalWall(instant time.Time, loc *time.Location) time.Time {
	local := instant.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), time.UTC)
}

func calendarOffsetChanges(at time.Time, loc *time.Location) bool {
	_, before := at.Add(-time.Nanosecond).In(loc).Zone()
	_, after := at.In(loc).Zone()
	return before != after
}

// Resolve wall midnight using zone intervals rather than time.Date's unspecified
// choice at overlaps. Gaps use the first valid instant, matching startOfDay.
func calendarWall(wall time.Time, loc *time.Location, later bool) (time.Time, error) {
	from, to := wall.Add(-72*time.Hour), wall.Add(72*time.Hour)
	matches := []time.Time{}
	seen := map[int]bool{}
	var gap time.Time
	for cursor := from; cursor.Before(to); {
		local := cursor.In(loc)
		_, offset := local.Zone()
		start, end := local.ZoneBounds()
		if !seen[offset] {
			seen[offset] = true
			candidate := wall.Add(-time.Duration(offset) * time.Second)
			// ZoneBounds includes synthetic UTC year boundaries for POSIX
			// extensions. Validate against the actual offset at the candidate.
			if calendarLocalWall(candidate, loc).Equal(wall) {
				matches = append(matches, candidate)
			}
		}
		if !start.IsZero() && calendarOffsetChanges(start, loc) {
			before := calendarLocalWall(start.Add(-time.Nanosecond), loc).Add(time.Nanosecond)
			after := calendarLocalWall(start, loc)
			if !wall.Before(before) && wall.Before(after) && (gap.IsZero() || start.Before(gap)) {
				gap = start
			}
		}
		if !end.IsZero() && !end.After(cursor) {
			// Go's POSIX extension uses a 365-day year end, which can be
			// behind cursor on a leap year's final day. Continue at UTC Jan 1.
			end = time.Date(cursor.UTC().Year()+1, 1, 1, 0, 0, 0, 0, time.UTC)
		}
		if end.IsZero() || !end.Before(to) {
			break
		}
		cursor = end
	}
	if len(matches) > 0 {
		sort.Slice(matches, func(i, j int) bool { return matches[i].Before(matches[j]) })
		if later {
			return matches[len(matches)-1], nil
		}
		return matches[0], nil
	}
	if !gap.IsZero() {
		return gap, nil
	}
	return time.Time{}, diagnostic(ErrorCodeDateGrouping, "unresolvable calendar boundary")
}
func calendarFloor(instant time.Time, interval string, loc *time.Location) (time.Time, error) {
	interval = calendarUnit(interval)
	local := instant.In(loc)
	_, offset := local.Zone()
	if interval == "hour" {
		wall := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, time.UTC)
		floor := wall.Add(-time.Duration(offset) * time.Second)
		start, _ := local.ZoneBounds()
		if !start.IsZero() && start.After(floor) && calendarOffsetChanges(start, loc) {
			floor = start
		}
		return floor.UTC(), nil
	}
	y, m, day := local.Date()
	wall := time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
	if interval == "week" {
		wall = wall.AddDate(0, 0, -((int(local.Weekday()) + 6) % 7))
	}
	if interval == "month" {
		wall = time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	}
	if interval == "year" {
		wall = time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	return calendarWall(wall, loc, false)
}
func calendarNext(instant time.Time, interval string, loc *time.Location) (time.Time, error) {
	interval = calendarUnit(interval)
	local := instant.In(loc)
	y, m, day := local.Date()
	wall := time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
	if interval == "hour" {
		wall = time.Date(y, m, day, local.Hour()+1, 0, 0, 0, time.UTC)
		next, err := calendarWall(wall, loc, false)
		if err != nil {
			return next, err
		}
		if !next.After(instant) {
			next, err = calendarWall(wall, loc, true)
			if err != nil {
				return next, err
			}
		}
		_, transition := local.ZoneBounds()
		if !transition.IsZero() && transition.After(instant) && transition.Before(next) && calendarOffsetChanges(transition, loc) {
			next = transition
		}
		return next.UTC(), nil
	}
	switch interval {
	case "day":
		wall = wall.AddDate(0, 0, 1)
	case "week":
		wall = wall.AddDate(0, 0, 7)
	case "month":
		wall = time.Date(y, m+1, 1, 0, 0, 0, 0, time.UTC)
	case "year":
		wall = time.Date(y+1, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	return calendarWall(wall, loc, false)
}
func calendarInput(value string, loc *time.Location) (time.Time, error) {
	if !calendarDatePattern.MatchString(value) {
		return time.Time{}, diagnostic(ErrorCodeDateGrouping, "use ISO dates or timestamps with an explicit offset")
	}
	if len(value) == 10 {
		date, err := time.Parse("2006-01-02", value)
		if err != nil {
			return date, diagnostic(ErrorCodeDateGrouping, "invalid calendar date")
		}
		return calendarWall(date, loc, false)
	}
	instant, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return instant, diagnostic(ErrorCodeDateGrouping, "invalid calendar instant")
	}
	return instant, nil
}
func calendarRange(config MetricDateGrouping, q metricRequest, observed []time.Time, now time.Time, loc *time.Location) (time.Time, time.Time, bool, error) {
	var min, max time.Time
	for _, t := range observed {
		if min.IsZero() || t.Before(min) {
			min = t
		}
		if max.IsZero() || t.After(max) {
			max = t
		}
	}
	if config.Range == "observed" {
		return min, max, len(observed) > 0, nil
	}
	var start, end time.Time
	if config.Range == "custom" {
		var err error
		start, err = calendarInput(config.Start, loc)
		if err != nil {
			return start, end, false, err
		}
		end, err = calendarInput(config.End, loc)
		if err != nil {
			return start, end, false, err
		}
		if len(config.End) == 10 {
			end, err = calendarNext(end, "day", loc)
			if err != nil {
				return start, end, false, err
			}
			end = end.Add(-time.Millisecond)
		}
		if end.Before(start) {
			return start, end, false, diagnostic(ErrorCodeDateGrouping, "end date must be on or after start date")
		}
		start, err = calendarFloor(start, config.Interval, loc)
		if err != nil {
			return start, end, false, err
		}
		end, err = calendarFloor(end, config.Interval, loc)
		if err != nil {
			return start, end, false, err
		}
		if len(observed) > 0 && (start.After(min) || end.Before(max)) {
			return start, end, false, diagnostic(ErrorCodeDateGrouping, "custom date bounds must include all observed buckets")
		}
		return start, end, true, nil
	}
	for _, term := range q.Where {
		if term.Value == "" || term.IsGroup() || term.Negated || term.Field != config.Field || !containsString([]string{"=", ">", ">=", "<", "<="}, term.Op) {
			continue
		}
		resolved, err := ResolveRelativeDatetime(term.Value, now)
		if err != nil {
			return start, end, false, err
		}
		value, err := calendarInput(resolved, time.UTC)
		if err != nil {
			return start, end, false, err
		}
		if term.Op == ">" {
			value = value.Add(time.Millisecond)
		}
		if term.Op == "<" {
			value = value.Add(-time.Millisecond)
		}
		if term.Op == "=" || term.Op == ">" || term.Op == ">=" {
			if start.IsZero() || value.After(start) {
				start = value
			}
		}
		if term.Op == "=" || term.Op == "<" || term.Op == "<=" {
			if end.IsZero() || value.Before(end) {
				end = value
			}
		}
	}
	if start.IsZero() || end.IsZero() {
		return start, end, false, diagnostic(ErrorCodeDateGrouping, "include empty dates needs a bounded date filter, observed dates, or a custom range")
	}
	if end.Before(start) {
		return start, end, false, nil
	}
	start, err := calendarFloor(start, config.Interval, loc)
	if err != nil {
		return start, end, false, err
	}
	end, err = calendarFloor(end, config.Interval, loc)
	return start, end, true, err
}

// computed types canonical computed fields absent from s, as staging does;
// direct execution reads them from the source plan.
func (d QueryDatasetV3) executeMetric(ctx context.Context, tx *sql.Tx, spec AggSpec, q metricRequest, s Schema, computed map[string]FieldSpec, o PlanOptions, total int64, maxGroups int, tables *[]string) (MetricResult, error) {
	if spec.DateGrouping == nil {
		if err := d.checkMetricSamples(ctx, tx, spec, q, s, o, maxGroups); err != nil {
			return MetricResult{}, err
		}
		p, err := compileMetricDialect(ctx, q, spec, s, o, d.Dialect == "sqlite")
		if err == nil {
			p, err = compileMetricDialect(ctx, q, spec, narrowSchema(s, p.Dependencies, q.OrderBy, q.Where, spec.Where), o, d.Dialect == "sqlite")
		}
		if err != nil {
			return MetricResult{}, err
		}
		return (sqliteV2Dataset{}).readV2Metric(ctx, tx, metricSQLPlan{spec.ID, p}, spec, total, q, maxGroups)
	}
	config := *spec.DateGrouping
	loc, err := calendarLocation(config)
	if err != nil {
		return MetricResult{}, err
	}
	field, ok := s.Fields[config.Field]
	if !ok {
		field, ok = computed[config.Field]
	}
	if !ok || field.Kind != FieldDatetime || !fieldGroupable(field) || len(spec.GroupBy) == 0 || spec.GroupBy[0] != config.Field || spec.Distribution != nil {
		return MetricResult{}, diagnostic(ErrorCodeDateGrouping, "calendar grouping requires the first datetime key and scalar metrics")
	}
	if _, err = metricOrder(spec, len(spec.GroupBy), spec.ExpressionY != "", false); err != nil {
		return MetricResult{}, err
	}
	rowQuery := WireQuery{Where: q.Where, OrderBy: q.OrderBy}
	if spec.Scope == "shownRows" {
		rowQuery.Limit = q.Limit
		rowQuery.Offset = q.Offset
	}
	// Select only this metric's expression, key, filter and window dependencies.
	// The source/result projection can include many unrelated, large values.
	plain := spec
	plain.DateGrouping = nil
	dependencyPlan, err := compileMetricDialect(ctx, q, plain, s, o, d.Dialect == "sqlite")
	if err != nil {
		return MetricResult{}, err
	}
	names := append([]string{s.IDField, config.Field}, dependencyPlan.Dependencies...)
	sort.Strings(names)
	rowQuery.Select = uniqueStrings(names)
	_, _, maxPopulation, maxBytes, err := d.limits()
	if err != nil {
		return MetricResult{}, err
	}
	var p SQLPlan
	if spec.Scope == "shownRows" {
		p, err = compileComputedRowsDialect(ctx, rowQuery, s, o, d.Dialect == "sqlite")
	} else {
		// An all-matching reduction has no row ordering semantics.
		rowQuery.OrderBy = nil
		rowQuery.Limit = maxPopulation + 1
		p, err = compileQuerySource(ctx, rowQuery, s, o, d.Dialect == "sqlite")
	}
	if err != nil {
		return MetricResult{}, err
	}
	dateAlias := ""
	for _, column := range p.Columns {
		if column.Field == config.Field {
			dateAlias = column.ValueAlias
		}
	}
	// Include the ordinal and 24-byte ISO key in this metric's scratch budget.
	sizeSQL := d.stagingSizeSQL(p.Columns, "8", "CASE WHEN "+queryIdent(dateAlias)+" IS NULL THEN 0 ELSE 24 END")
	if err = d.checkCalendarStaging(ctx, tx, "("+p.SQL+") AS qt_calendar_budget", sizeSQL, p.Args, maxPopulation, maxBytes); err != nil {
		return MetricResult{}, err
	}
	table := queryTableName()
	*tables = append(*tables, table)
	if err = d.stageCalendarSource(ctx, tx, table, p); err != nil {
		return MetricResult{}, err
	}
	// A calendar scratch relation lives for one metric, rather than accumulating
	// with every calendar clause in the request. ExecuteIn also retains a fallback
	// cleanup entry for failures/cancelled transactions.
	defer func() {
		_ = d.dropQueryTables(ctx, tx, []string{table})
	}()
	if err = d.checkCalendarStaging(ctx, tx, queryIdent(table), sizeSQL, nil, maxPopulation, maxBytes); err != nil {
		return MetricResult{}, err
	}
	if d.Dialect != "sqlite" {
		if _, err = tx.ExecContext(ctx, "CREATE UNIQUE INDEX "+queryIdent(table+"_index")+" ON "+queryIdent(table)+" (qt_calendar_row)"); err != nil {
			return MetricResult{}, err
		}
	}
	if _, err = tx.ExecContext(ctx, "ALTER TABLE "+queryIdent(table)+" ADD COLUMN qt_calendar_key TEXT"); err != nil {
		return MetricResult{}, err
	}
	calendarSchema := Schema{Name: s.Name, IDField: s.IDField, Fields: map[string]FieldSpec{}}
	for _, column := range p.Columns {
		original, ok := s.Fields[column.Field]
		if !ok {
			original = computed[column.Field]
		}
		original.Expr = "r." + queryIdent(column.ValueAlias)
		original.ValueErrorExpr = "r." + queryIdent(column.ErrorAlias)
		original.SortExpr = ""
		if original.Kind == FieldDatetime {
			original.SQLiteDatetimeFormat = "rfc3339"
		}
		calendarSchema.Fields[column.Field] = original
		if column.Field == config.Field {
			dateAlias = column.ValueAlias
		}
	}
	if err = d.keyCalendarColumn(ctx, tx, table, dateAlias, "qt_calendar_key", "text", config.Interval, loc); err != nil {
		return MetricResult{}, err
	}
	bucketName := "__qt_calendar_bucket__"
	if _, exists := calendarSchema.Fields[bucketName]; exists {
		return MetricResult{}, diagnostic(ErrorCodeSchema, "reserved calendar field collision")
	}
	// Text ISO keys avoid PostgreSQL interpreting a staged datetime string under
	// the connection timezone; original datetime inputs remain available to formulas.
	calendarSchema.Fields[bucketName] = resultField(bucketName, "text", "r.qt_calendar_key", true)
	calendarKey := calendarSchema.Fields[bucketName]
	calendarKey.ValueErrorExpr = calendarSchema.Fields[config.Field].ValueErrorExpr
	calendarSchema.Fields[bucketName] = calendarKey
	modified := spec
	modified.DateGrouping = nil
	modified.Scope = "allMatching"
	modified.Sort = nil
	modified.GroupLimit = 0
	// MinCount is applied below, after empty buckets are filled; the metric
	// filter runs over the staged rows (the page for shown-row scope). Without
	// Min, a measured minimum only reports each group's measure.
	modified.MinCount = MetricMinCount{Distinct: spec.MinCount.Distinct, Sum: spec.MinCount.Sum}
	modified.GroupBy = append([]string{}, spec.GroupBy...)
	modified.GroupBy[0] = bucketName
	options := o
	options.SourceSQL = "SELECT * FROM " + queryIdent(table)
	options.SourceArgs = nil
	if err = d.checkMetricSamples(ctx, tx, modified, metricRequest{Version: 2}, calendarSchema, options, maxGroups); err != nil {
		return MetricResult{}, err
	}
	metricPlan, err := compileMetricDialect(ctx, metricRequest{Version: 2}, modified, calendarSchema, options, d.Dialect == "sqlite")
	if err != nil {
		return MetricResult{}, err
	}
	result, err := (sqliteV2Dataset{}).readV2Metric(ctx, tx, metricSQLPlan{spec.ID, metricPlan}, modified, total, q, maxGroups)
	if err != nil {
		return result, err
	}
	if calendarCycle(config.Interval) {
		// Slots are staged as text, like calendar keys, and returned as numbers.
		for i := range result.Buckets {
			if text, ok := result.Buckets[i].Keys[0].(string); ok {
				slot, e := strconv.Atoi(text)
				if e != nil {
					return result, diagnostic(ErrorCodeDateGrouping, "invalid calendar slot")
				}
				result.Buckets[i].Keys[0] = float64(slot)
			}
		}
	}
	result.Scope = spec.Scope
	if result.Scope == "" {
		result.Scope = "allMatching"
	}
	if result.Scope == "shownRows" {
		result.ProcessedRows = total - int64(q.Offset)
		if result.ProcessedRows < 0 {
			result.ProcessedRows = 0
		}
		if result.ProcessedRows > int64(q.Limit) {
			result.ProcessedRows = int64(q.Limit)
		}
	}
	if config.IncludeEmpty {
		if err = fillCalendarBuckets(ctx, &result, config, spec, q, o.Now, loc, maxGroups); err != nil {
			return result, err
		}
	}
	if spec.MinCount.Active() {
		// Filled buckets (count 0) are never hidden. A hidden observed bucket
		// leaves a gap: it is not replaced by an empty bucket.
		kept := result.Buckets[:0]
		hidden := int64(0)
		for _, bucket := range result.Buckets {
			if !spec.MinCount.keeps(bucket.Count, bucket.minMeasure, bucket.minMeasureError) {
				hidden++
			} else {
				kept = append(kept, bucket)
			}
		}
		result.Buckets = kept
		result.HiddenGroups = &hidden
	}
	sortCalendarBuckets(result.Buckets, spec)
	result.GroupCount = int64(len(result.Buckets))
	if spec.GroupLimit > 0 && len(result.Buckets) > spec.GroupLimit {
		shape := metricOtherShape(spec)
		result.Other = shape.remainder(spec, otherSumsFromBuckets(result.Buckets[spec.GroupLimit:], len(shape.columns())))
		result.Buckets = result.Buckets[:spec.GroupLimit]
	}
	return result, nil
}
func fillCalendarBuckets(ctx context.Context, result *MetricResult, config MetricDateGrouping, spec AggSpec, q metricRequest, now time.Time, loc *time.Location, maxGroups int) error {
	observed := []time.Time{}
	series := map[string][]any{}
	present := map[string]bool{}
	cycle := calendarCycle(config.Interval)
	for _, bucket := range result.Buckets {
		key, _ := jsonValues(bucket.Keys)
		present[key] = true
		if len(bucket.Keys) > 0 && bucket.Keys[0] != nil {
			if !cycle {
				date, err := calendarInput(fmt.Sprint(bucket.Keys[0]), time.UTC)
				if err != nil {
					return err
				}
				observed = append(observed, date)
			}
			tuple := bucket.Keys[1:]
			key, _ = jsonValues(tuple)
			series[key] = tuple
		}
	}
	if len(spec.GroupBy) == 1 && len(series) == 0 {
		series["[]"] = []any{}
	}
	empty := func(expression string) any {
		node, err := parseExpression(expression)
		if err == nil && containsString([]string{"COUNT", "COUNT_DISTINCT", "SUM"}, strings.ToUpper(node.op)) {
			return float64(0)
		}
		return nil
	}
	add := func(keys []any) error {
		key, _ := jsonValues(keys)
		if present[key] {
			return nil
		}
		if len(result.Buckets) >= maxGroups {
			return diagnostic(ErrorCodeResourceLimit, "calendar group population exceeds host budget")
		}
		bucket := MetricBucket{Keys: keys, Count: 0, Value: empty(metricExpression(spec))}
		if spec.ExpressionY != "" {
			value := empty(spec.ExpressionY)
			bucket.Y = &value
		}
		result.Buckets = append(result.Buckets, bucket)
		present[key] = true
		return nil
	}
	if cycle {
		// Every slot of a cycle exists, whatever the date range.
		for _, slot := range calendarSlots(config.Interval) {
			for _, tuple := range series {
				if err := add(append([]any{slot}, tuple...)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	start, end, has, err := calendarRange(config, q, observed, now, loc)
	if err != nil {
		return err
	}
	if !has {
		return nil
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// With multiple keys, only series observed at nonnull dates are filled.
	// Without any such series there is no work, regardless of the date range.
	if len(series) == 0 {
		return nil
	}
	for at := start; !at.After(end); {
		if err = ctx.Err(); err != nil {
			return err
		}
		for _, tuple := range series {
			if err = add(append([]any{at.UTC().Format("2006-01-02T15:04:05.000Z")}, tuple...)); err != nil {
				return err
			}
		}
		next, e := calendarNext(at, config.Interval, loc)
		if e != nil {
			return e
		}
		if !next.After(at) {
			return diagnostic(ErrorCodeDateGrouping, "calendar boundaries must advance")
		}
		at = next
	}
	return nil
}
func (d QueryDatasetV3) checkMetricSamples(ctx context.Context, tx *sql.Tx, spec AggSpec, q metricRequest, s Schema, o PlanOptions, maxGroups int) error {
	if !metricSampled(spec, d.Dialect == "sqlite") {
		return nil
	}
	probe := AggSpec{ID: "__qt_samples__", Op: "count", GroupBy: spec.GroupBy, Scope: spec.Scope, Where: spec.Where}
	p, err := compileMetricDialect(ctx, q, probe, s, o, d.Dialect == "sqlite")
	if err != nil {
		return err
	}
	metric, err := (sqliteV2Dataset{}).readV2Metric(ctx, tx, metricSQLPlan{probe.ID, p}, probe, 0, q, maxGroups)
	if err != nil {
		return err
	}
	limit, err := d.sampleLimit()
	if err != nil {
		return err
	}
	for _, bucket := range metric.Buckets {
		if bucket.Count > int64(limit) {
			return diagnostic(ErrorCodeResourceLimit, sampleBudgetMessage(spec, limit))
		}
	}
	return nil
}
func jsonValues(values []any) (string, error) {
	pairs := [][]any{}
	for i, value := range values {
		pairs = append(pairs, []any{strconv.Itoa(i), value})
	}
	return jsonTuple(pairs), nil
}
func compareQueryValues(a, b any) int {
	if a == nil {
		if b == nil {
			return 0
		}
		return 1
	}
	if b == nil {
		return -1
	}
	if left, ok := a.(float64); ok {
		right, _ := b.(float64)
		if left < right {
			return -1
		}
		if left > right {
			return 1
		}
		return 0
	}
	if left, ok := a.(int64); ok {
		right, _ := b.(int64)
		if left < right {
			return -1
		}
		if left > right {
			return 1
		}
		return 0
	}
	if left, ok := a.(bool); ok {
		right, _ := b.(bool)
		if left == right {
			return 0
		}
		if !left {
			return -1
		}
		return 1
	}
	left, right := []rune(fmt.Sprint(a)), []rune(fmt.Sprint(b))
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] < right[i] {
			return -1
		}
		if left[i] > right[i] {
			return 1
		}
	}
	if len(left) < len(right) {
		return -1
	}
	if len(left) > len(right) {
		return 1
	}
	return 0
}
func sortCalendarBuckets(buckets []MetricBucket, spec AggSpec) {
	ordering := spec.Sort
	if len(ordering) == 0 {
		ordering = []MetricSort{{Key: "group0", Dir: "asc", Nulls: "last"}}
	}
	target := func(bucket MetricBucket, sort MetricSort) any {
		switch sort.Key {
		case "value":
			return bucket.Value
		case "count":
			return bucket.Count
		case "y":
			if bucket.Y != nil {
				return *bucket.Y
			}
			return nil
		}
		if strings.HasPrefix(sort.Key, "group") {
			index, _ := strconv.Atoi(sort.Key[5:])
			if index < len(bucket.Keys) {
				return bucket.Keys[index]
			}
		}
		return nil
	}
	sort.SliceStable(buckets, func(i, j int) bool {
		a, b := buckets[i], buckets[j]
		badA, badB := a.Error != "" || a.YError != "", b.Error != "" || b.YError != ""
		if badA != badB {
			return !badA
		}
		for _, s := range ordering {
			left, right := target(a, s), target(b, s)
			cmp := compareQueryValues(left, right)
			if left == nil || right == nil {
				if s.Nulls == "first" {
					cmp = -cmp
				}
			} else if s.Dir == "desc" {
				cmp = -cmp
			}
			if cmp != 0 {
				return cmp < 0
			}
		}
		for k := range a.Keys {
			if cmp := compareQueryValues(a.Keys[k], b.Keys[k]); cmp != 0 {
				return cmp < 0
			}
		}
		return false
	})
}

// Read and write bounded batches with the cursor closed between them. Neither
// Go memory nor SQLite/PostgreSQL statement count grows by one per source row.
// Each row's key (its interval start, or its cyclic slot) is written to the
// column named key, cast to keyType, by the row's qt_calendar_row ordinal.
func (d QueryDatasetV3) keyCalendarColumn(ctx context.Context, tx *sql.Tx, table, dateAlias, key, keyType, interval string, loc *time.Location) error {
	if d.Dialect == "sqlite" {
		if done, err := d.sqliteKeyCalendarColumn(ctx, tx, table, dateAlias, key, keyType, interval, loc); done || err != nil {
			return err
		}
	}
	const batchSize = 400 // Two parameters per key fit SQLite's legacy 999 limit.
	var after int64
	for {
		rows, err := tx.QueryContext(ctx, "SELECT qt_calendar_row,"+queryIdent(dateAlias)+" FROM "+queryIdent(table)+" WHERE qt_calendar_row>"+d.param(1)+" ORDER BY qt_calendar_row LIMIT "+strconv.Itoa(batchSize), after)
		if err != nil {
			return err
		}
		values := []string{}
		args := []any{}
		scanned := 0
		for rows.Next() {
			var id int64
			var raw any
			if err = rows.Scan(&id, &raw); err != nil {
				rows.Close()
				return err
			}
			scanned++
			after = id
			if raw == nil {
				continue
			}
			instant, e := calendarInput(fmt.Sprint(typedQueryValue(raw, "datetime")), time.UTC)
			if e != nil {
				rows.Close()
				return e
			}
			floor, e := calendarFloor(instant, interval, loc)
			if e != nil {
				rows.Close()
				return e
			}
			key := floor.Format("2006-01-02T15:04:05.000Z")
			if calendarCycle(interval) {
				// The slot of the interval the record falls in, as TypeScript keys it.
				key = strconv.Itoa(calendarSlot(floor, interval, loc))
			}
			values = append(values, "(CAST("+d.param(len(args)+1)+" AS bigint),CAST("+d.param(len(args)+2)+" AS "+keyType+"))")
			args = append(args, id, key)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(values) > 0 {
			update := "WITH qt_calendar_keys(ordinal,bucket) AS (VALUES " + strings.Join(values, ",") + ") UPDATE " + queryIdent(table) + " AS target SET " + queryIdent(key) + "=keys.bucket FROM qt_calendar_keys AS keys WHERE target.qt_calendar_row=keys.ordinal"
			if _, err = tx.ExecContext(ctx, update, args...); err != nil {
				return err
			}
		}
		if scanned < batchSize {
			return nil
		}
	}
}

// Calendar staging produces canonical UTC timestamps with nine fractional
// digits. Their BINARY order is instant order. For bounded observed ranges,
// compute the exact timezone boundaries once, then assign keys in one UPDATE
// using a balanced decision tree. No rows cross the driver or get rebound as
// VALUES. Sparse/wide ranges retain the bounded per-row implementation above.
// Both paths use calendarFloor/calendarNext, including DST and cyclic keys.
func (d QueryDatasetV3) sqliteKeyCalendarColumn(ctx context.Context, tx *sql.Tx, table, dateAlias, key, keyType, interval string, loc *time.Location) (bool, error) {
	const layout = "2006-01-02T15:04:05.000000000Z"
	const maxBoundaries = 256 // At most 511 bindings, below legacy SQLite's 999.
	column := queryIdent(dateAlias) + " COLLATE BINARY"
	var low, high sql.NullString
	if err := tx.QueryRowContext(ctx, "SELECT MIN("+column+"),MAX("+column+") FROM "+queryIdent(table)).Scan(&low, &high); err != nil {
		return false, err
	}
	if !low.Valid && !high.Valid {
		return true, nil
	}
	start, err := time.Parse(layout, low.String)
	if err != nil || start.Year() < 1 || start.UTC().Format(layout) != low.String {
		return false, nil
	}
	end, err := time.Parse(layout, high.String)
	if err != nil || end.Year() > 9998 || end.UTC().Format(layout) != high.String {
		return false, nil
	}
	floor, err := calendarFloor(start, interval, loc)
	if err != nil || floor.After(start) {
		return false, nil
	}
	boundaries := []time.Time{}
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		boundaries = append(boundaries, floor)
		if len(boundaries) > maxBoundaries {
			return false, nil
		}
		next, err := calendarNext(floor, interval, loc)
		if err != nil || !next.After(floor) {
			return false, nil
		}
		// A skipped civil date can make Next's wall-time resolution land
		// inside the following period. It is not an interval boundary; keep
		// the authoritative per-row floor for that exceptional timezone range.
		verified, err := calendarFloor(next, interval, loc)
		if err != nil || !verified.Equal(next) {
			return false, nil
		}
		if next.After(end) {
			break
		}
		// Next may retain a location at a skipped-date transition. Floor's
		// representation must supply the key, exactly as the per-row path does.
		floor = verified
	}
	args := []any{}
	bind := func(value string) string {
		args = append(args, value)
		return d.param(len(args))
	}
	var decision func(int, int) string
	decision = func(lo, hi int) string {
		if hi-lo == 1 {
			bucket := boundaries[lo].Format("2006-01-02T15:04:05.000Z")
			if calendarCycle(interval) {
				bucket = strconv.Itoa(calendarSlot(boundaries[lo], interval, loc))
			}
			return "CAST(" + bind(bucket) + " AS " + keyType + ")"
		}
		mid := lo + (hi-lo)/2
		pivot := bind(boundaries[mid].UTC().Format(layout))
		return "CASE WHEN " + column + "<" + pivot + " THEN " + decision(lo, mid) + " ELSE " + decision(mid, hi) + " END"
	}
	expression := decision(0, len(boundaries))
	_, err = tx.ExecContext(ctx, "UPDATE "+queryIdent(table)+" SET "+queryIdent(key)+"="+expression+" WHERE "+queryIdent(dateAlias)+" IS NOT NULL", args...)
	return true, err
}
