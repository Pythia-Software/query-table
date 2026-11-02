package querytable

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ExecuteV2Rows runs V2 metrics over an already-authorized in-memory population.
// It never executes SourceSQL. tx is used only for expected computed revisions
// when no Resolver was supplied; ordinary requests can pass nil. SourceSQL may
// be empty. Callers must bind token/snapshot validation to this same population.
//
// Row keys are schema field names with direct SQL column bindings. Supported
// storage is nil/missing (NULL), string (TEXT), int64 (INTEGER), float64 (REAL),
// and bool for bool fields (bound as 0/1). Text arrays use JSON strings; empty
// datetime strings are NULL. No other Go types are implicitly coerced.
//
// Count, count(field), sum/avg/min/max of numbers, min/max of text/enum/datetime,
// count_distinct of scalar fields, and box and histogram distributions of a
// number field are supported, with text/enum/bool grouping, per-metric Where,
// MinCount (of rows, distinct values or a sum), sorting and GroupLimit.
// Formulas (including distribution inputs other than one field), computed
// fields, shownRows and other groupings return ErrRowsUnsupported.
// Runtime fallback also returns an empty result, so hosts can safely stage and
// retry the complete request. Field storage errors retain V2 bucket diagnostics.
func ExecuteV2Rows(ctx context.Context, tx *sql.Tx, d SQLiteV2Dataset, rows []map[string]any, q MetricQuery, o PlanOptions) (SQLiteV2ExecutionResult, error) {
	return executeV2Rows(ctx, tx, d, rows, q, o, nil)
}

// visit is a test hook for counting physical population visits.
func executeV2Rows(ctx context.Context, tx *sql.Tx, d SQLiteV2Dataset, rows []map[string]any, q MetricQuery, o PlanOptions, visit func()) (SQLiteV2ExecutionResult, error) {
	out := SQLiteV2ExecutionResult{}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	if d.SourceSQL == "" {
		d.SourceSQL = "SELECT 1"
	}
	maxRows, maxGroups, maxPopulation, err := d.limits()
	if err != nil {
		return out, err
	}
	if q.Limit > maxRows {
		return out, diagnostic("resource_limit", "metric row window exceeds host budget")
	}
	o = d.options(tx, o)
	for _, term := range q.Where {
		for _, p := range term.Predicates() {
			if strings.HasPrefix(p.Field, "@computed/") {
				return out, fmt.Errorf("%w: computed filter %s", ErrRowsUnsupported, p.Field)
			}
		}
	}
	for _, spec := range q.Metrics {
		if name := rowMetricComputedField(spec); name != "" {
			return out, fmt.Errorf("%w: computed field %s", ErrRowsUnsupported, name)
		}
	}
	// Reuse the SQL compiler for policy, request and clause validation. It builds
	// plans only: no SQL runs here, including on the nil-transaction fast path.
	_, failures, err := compileMetricsPartial(ctx, q, d.Schema, o, true)
	if err != nil {
		return out, err
	}
	filter, err := CompileRowFilter(q.Where, d.Schema, SQLiteOptions{Now: o.Now})
	if err != nil {
		return out, err
	}
	revisions := o.ExpectedRevisions
	if q.ExpectedRevisions != nil {
		revisions = q.ExpectedRevisions
	}
	reducer, err := newRowMetrics(ctx, q, d.Schema, o, failures, maxGroups, rowMetricsOptions{bound: rowFieldSupported})
	if err != nil {
		return out, err
	}
	total := int64(0)
	for i, row := range rows {
		if visit != nil {
			visit()
		}
		if i%256 == 0 {
			if err = ctx.Err(); err != nil {
				return out, err
			}
		}
		matches, e := filter.Match(row)
		if e != nil {
			return out, e
		}
		if !matches {
			continue
		}
		total++
		if total > int64(maxPopulation) {
			return out, diagnostic("resource_limit", "matching population exceeds host budget")
		}
		if e = reducer.add(row, nil); e != nil {
			return out, e
		}
	}
	if err = ctx.Err(); err != nil {
		return out, err
	}
	// Match ExecuteV2In's request-error priority: population bounds are
	// enforced before checking revision entries unused by the metric plans.
	if _, _, err = d.verifyV2Revisions(ctx, o, revisions); err != nil {
		return out, err
	}
	result, err := reducer.finish(total)
	if err != nil {
		return out, err
	}
	out.Metrics = &result
	return out, nil
}

// rowMetricComputedField names a computed field read by spec, if any.
func rowMetricComputedField(spec AggSpec) string {
	names := append([]string{spec.Field, spec.MinCount.field()}, spec.GroupBy...)
	for _, term := range spec.Where {
		for _, p := range term.Predicates() {
			names = append(names, p.Field)
		}
	}
	expressions := []string{spec.Expression}
	if spec.Distribution != nil {
		expressions = append(expressions, spec.Distribution.Input)
	}
	for _, expression := range expressions {
		if expression != "" {
			if n, e := parseExpression(expression); e == nil {
				names = append(names, rowExpressionFields(n)...)
			}
		}
	}
	for _, name := range names {
		if strings.HasPrefix(name, "@computed/") {
			return name
		}
	}
	return ""
}

// rowMetrics reduces V2 metrics over rows keyed by schema field name. The
// in-memory executor and the direct SQLite distribution path share it.
type rowMetrics struct {
	result    SQLiteMetricsV2Result
	cohorts   []*rowMetricCohort
	maxGroups int
}

type rowMetricsOptions struct {
	// include selects metrics by index; nil selects every metric.
	include []bool
	// bound reports whether rows carry the field's stored value.
	bound func(name string, f FieldSpec) bool
	// whereFlag, when set, returns the index of a precomputed row flag for a
	// metric's Where (or -1 for none) instead of compiling a RowFilter.
	whereFlag func([]WhereTerm) int
}

// newRowMetrics prepares the selected metrics, or returns ErrRowsUnsupported
// for a metric shape or binding the row reducers cannot compute exactly.
func newRowMetrics(ctx context.Context, q MetricQuery, s Schema, o PlanOptions, failures []error, maxGroups int, options rowMetricsOptions) (*rowMetrics, error) {
	r := &rowMetrics{result: SQLiteMetricsV2Result{Metrics: make([]SQLiteMetricV2, len(q.Metrics))}, maxGroups: maxGroups}
	byPopulation := map[string]*rowMetricCohort{}
	for i, spec := range q.Metrics {
		if options.include != nil && !options.include[i] {
			continue
		}
		if failures[i] != nil {
			message, _ := metricClauseError(ctx, failures[i])
			r.result.Metrics[i] = failedMetric(spec.ID, spec.Scope, message)
			continue
		}
		m, e := rowMetricShape(spec, s, options.bound)
		if e != nil {
			return nil, e
		}
		m.index = i
		key, _ := json.Marshal(struct {
			Groups []string
			Where  []WhereTerm
		}{spec.GroupBy, spec.Where})
		c := byPopulation[string(key)]
		if c == nil {
			c = &rowMetricCohort{groupBy: spec.GroupBy, groups: map[string]*rowMetricGroup{}, flag: -1}
			if options.whereFlag != nil {
				c.flag = options.whereFlag(spec.Where)
			} else if c.filter, e = CompileRowFilter(spec.Where, s, SQLiteOptions{Now: o.Now}); e != nil {
				return nil, e
			}
			for _, name := range spec.GroupBy {
				c.groupFields = append(c.groupFields, rowMetricGroupField{name: name, binding: s.Fields[name]})
			}
			r.cohorts = append(r.cohorts, c)
			byPopulation[string(key)] = c
		}
		m.reduction = c.reducer(m)
		// A measured minimum is one more reducer, shared with an identical
		// metric in this cohort.
		if name := spec.MinCount.field(); name != "" {
			f := s.Fields[name]
			if !options.bound(name, f) || f.Kind == FieldTextArray {
				return nil, fmt.Errorf("%w: minCount binding %s", ErrRowsUnsupported, name)
			}
			measure := rowMetricSpec{index: i, spec: spec, op: "count_distinct", field: name, binding: f}
			if spec.MinCount.Sum != "" {
				measure.op = "sum"
			}
			m.threshold = c.reducer(measure)
			m.measure = &measure
		}
		c.metrics = append(c.metrics, m)
	}
	return r, nil
}

// rowMetricShape reads one compiled metric's operation and bindings.
func rowMetricShape(spec AggSpec, s Schema, bound func(string, FieldSpec) bool) (rowMetricSpec, error) {
	m := rowMetricSpec{spec: spec, reduction: -1, threshold: -1}
	if spec.Scope == "shownRows" || spec.DateGrouping != nil || spec.ExpressionY != "" {
		return m, fmt.Errorf("%w: metric %s shape", ErrRowsUnsupported, spec.ID)
	}
	expression := MetricExpression(spec)
	if spec.Distribution != nil {
		expression = spec.Distribution.Input
	}
	// Accept either shorthand or the equivalent single aggregate expression.
	n, e := parseExpression(expression)
	if e != nil {
		return m, e
	}
	if spec.Distribution != nil {
		// Distributions sample one stored number; formulas use SQL.
		if n.op != "field" {
			return m, fmt.Errorf("%w: metric %s distribution input", ErrRowsUnsupported, spec.ID)
		}
		m.op, m.field = "samples", n.text
		if f := s.Fields[m.field]; !bound(m.field, f) || f.Kind != FieldNumber {
			return m, fmt.Errorf("%w: metric binding %s", ErrRowsUnsupported, m.field)
		}
	} else {
		m.op = strings.ToLower(n.op)
		if len(n.args) == 1 && n.args[0].op == "field" {
			m.field = n.args[0].text
		} else if m.op != "count" || len(n.args) != 0 {
			return m, fmt.Errorf("%w: metric %s expression", ErrRowsUnsupported, spec.ID)
		}
		switch m.op {
		case "count", "count_distinct", "sum", "avg", "min", "max":
		default:
			return m, fmt.Errorf("%w: metric %s operation", ErrRowsUnsupported, spec.ID)
		}
		if m.field != "" {
			f := s.Fields[m.field]
			if !bound(m.field, f) || f.Kind == FieldTextArray {
				return m, fmt.Errorf("%w: metric binding %s", ErrRowsUnsupported, m.field)
			}
		}
	}
	m.binding = s.Fields[m.field]
	for _, name := range spec.GroupBy {
		f := s.Fields[name]
		if !bound(name, f) || f.Kind != FieldText && f.Kind != FieldEnum && f.Kind != FieldBool {
			return m, fmt.Errorf("%w: grouping %s", ErrRowsUnsupported, name)
		}
	}
	return m, nil
}

// add reduces one row of the matching population. flags holds the row's
// precomputed metric filters when rowMetricsOptions.whereFlag is set.
func (r *rowMetrics) add(row map[string]any, flags []bool) error {
	for _, c := range r.cohorts {
		// Overflow is a clause failure; keep scanning to enforce the request's
		// population bound and to produce unaffected sibling populations.
		if c.overflow {
			continue
		}
		matches := true
		if c.flag >= 0 {
			matches = flags[c.flag]
		} else {
			var e error
			if matches, e = c.filter.Match(row); e != nil {
				return e
			}
		}
		if !matches {
			continue
		}
		g, e := c.group(row, r.maxGroups)
		if e != nil {
			return e
		}
		if g == nil {
			continue
		}
		g.count++
		for j := range c.reducers {
			if e = g.reductions[j].step(row, &c.reducers[j]); e != nil {
				return e
			}
		}
	}
	return nil
}

// finish returns the selected metrics over a matching population of total rows.
func (r *rowMetrics) finish(total int64) (SQLiteMetricsV2Result, error) {
	result := r.result
	for _, c := range r.cohorts {
		// SQLite emits one ungrouped aggregate even for an empty population.
		if len(c.groupBy) == 0 && len(c.groups) == 0 {
			c.groups[""] = newRowMetricGroup([]any{}, len(c.reducers))
		}
		for _, m := range c.metrics {
			if c.overflow {
				result.Metrics[m.index] = failedMetric(m.spec.ID, m.spec.Scope, "group population exceeds host budget")
				continue
			}
			metric := SQLiteMetricV2{ID: m.spec.ID, Scope: "allMatching", ProcessedRows: total, Coverage: "exact", Buckets: []SQLiteMetricV2Bucket{}}
			var histogram *rowHistogram
			if m.op == "samples" && m.spec.Distribution.Kind == "histogram" {
				histogram = c.histogram(&m)
			}
			hidden := int64(0)
			for _, g := range c.groups {
				var measure any
				measureError := false
				if m.threshold >= 0 {
					value, code, e := g.reductions[m.threshold].value(m.measure)
					if e != nil {
						return result, e
					}
					measure, measureError = value, code != ""
				}
				if !m.spec.MinCount.keeps(g.count, measure, measureError) {
					hidden++
					continue
				}
				var bucket SQLiteMetricV2Bucket
				if m.op == "samples" {
					bucket = g.reductions[m.reduction].distribution(&m, histogram)
				} else {
					value, code, e := g.reductions[m.reduction].value(&m)
					if e != nil {
						return result, e
					}
					bucket = SQLiteMetricV2Bucket{Value: value, Error: code}
				}
				bucket.Keys, bucket.Count = append([]any{}, g.keys...), g.count
				metric.Buckets = append(metric.Buckets, bucket)
			}
			metric.GroupCount = int64(len(metric.Buckets))
			if m.spec.MinCount.Active() {
				metric.HiddenGroups = &hidden
			}
			sortRowMetric(metric.Buckets, m.spec)
			if m.spec.GroupLimit > 0 && len(metric.Buckets) > m.spec.GroupLimit {
				metric.Buckets = metric.Buckets[:m.spec.GroupLimit]
			}
			if (m.op == "min" || m.op == "max") && m.binding.Kind == FieldDatetime {
				for i := range metric.Buckets {
					metric.Buckets[i].Value = typedQueryValue(metric.Buckets[i].Value, "datetime")
				}
			}
			result.Metrics[m.index] = metric
		}
	}
	return result, nil
}

func rowExpressionFields(n *exprNode) []string {
	var names []string
	if n.op == "field" {
		names = append(names, n.text)
	}
	for _, arg := range n.args {
		names = append(names, rowExpressionFields(arg)...)
	}
	return names
}

// ExecuteV2Rows is also available as a dataset method, alongside ExecuteV2In.
func (d SQLiteV2Dataset) ExecuteV2Rows(ctx context.Context, tx *sql.Tx, rows []map[string]any, q MetricQuery, o PlanOptions) (SQLiteV2ExecutionResult, error) {
	return ExecuteV2Rows(ctx, tx, d, rows, q, o)
}

type rowMetricSpec struct {
	index     int
	reduction int
	// threshold is the reducer of a measured minCount (or -1), read as measure.
	threshold int
	measure   *rowMetricSpec
	spec      AggSpec
	// op "samples" collects a distribution's valid samples.
	op, field string
	binding   FieldSpec
}
type rowMetricCohort struct {
	filter RowFilter
	// flag indexes a precomputed filter of the row; -1 uses filter.
	flag        int
	groupBy     []string
	groupFields []rowMetricGroupField
	metrics     []rowMetricSpec
	reducers    []rowMetricSpec
	groups      map[string]*rowMetricGroup
	keyBuf      []byte
	overflow    bool
}
type rowMetricGroupField struct {
	name    string
	binding FieldSpec
}
type rowMetricGroup struct {
	keys       []any
	count      int64
	reductions []rowMetricReduction
}

// reducer returns the index of the cohort reducer for m's operation and field.
func (c *rowMetricCohort) reducer(m rowMetricSpec) int {
	for j, r := range c.reducers {
		if r.op == m.op && r.field == m.field {
			return j
		}
	}
	c.reducers = append(c.reducers, m)
	return len(c.reducers) - 1
}

func newRowMetricGroup(keys []any, n int) *rowMetricGroup {
	return &rowMetricGroup{keys: keys, reductions: make([]rowMetricReduction, n)}
}
func (c *rowMetricCohort) group(row map[string]any, limit int) (*rowMetricGroup, error) {
	c.keyBuf = c.keyBuf[:0]
	for i := range c.groupFields {
		field := &c.groupFields[i]
		// Length-prefixed text and separate NULL/boolean markers preserve the
		// typed tuple identity without JSON or allocations on group hits.
		switch value := row[field.name].(type) {
		case nil:
			c.keyBuf = append(c.keyBuf, 0)
		case float64:
			if !math.IsNaN(value) { // SQLite stores NaN as NULL.
				return c.newGroup(row, limit)
			}
			c.keyBuf = append(c.keyBuf, 0)
		case bool:
			if field.binding.Kind != FieldBool {
				return c.newGroup(row, limit)
			}
			marker := byte(1)
			if value {
				marker = 2
			}
			c.keyBuf = append(c.keyBuf, marker)
		case int64:
			if field.binding.Kind != FieldBool || value < 0 || value > 1 {
				return c.newGroup(row, limit)
			}
			c.keyBuf = append(c.keyBuf, byte(1+value))
		case string:
			if field.binding.Kind == FieldBool {
				return c.newGroup(row, limit)
			}
			c.keyBuf = append(c.keyBuf, 3)
			c.keyBuf = binary.AppendUvarint(c.keyBuf, uint64(len(value)))
			c.keyBuf = append(c.keyBuf, value...)
		default:
			return c.newGroup(row, limit)
		}
	}
	// Go avoids allocating the temporary string used solely for map lookup.
	// A hit proves this exact typed tuple already passed storage validation,
	// including text length, UTF-8 and NUL checks, when its group was created.
	if g := c.groups[string(c.keyBuf)]; g != nil {
		return g, nil
	}
	return c.newGroup(row, limit)
}

func (c *rowMetricCohort) newGroup(row map[string]any, limit int) (*rowMetricGroup, error) {
	// Validate in field order before enforcing the budget, retaining fallback
	// diagnostics even when a row could not be encoded by the lookup path.
	keys := make([]any, len(c.groupFields))
	for i := range c.groupFields {
		field := &c.groupFields[i]
		v, code, err := rowMetricValue(row[field.name], &field.binding)
		if err != nil {
			return nil, err
		}
		if code != "" {
			return nil, fmt.Errorf("%w: grouping storage %s", ErrRowsUnsupported, field.name)
		}
		if field.binding.Kind == FieldBool && v != nil {
			v = v.(int64) != 0
		}
		keys[i] = v
	}
	if len(c.groups) >= limit {
		c.overflow = true
		c.groups = nil
		return nil, nil
	}
	g := newRowMetricGroup(keys, len(c.reducers))
	c.groups[string(c.keyBuf)] = g
	return g, nil
}

func rowMetricValue(raw any, f *FieldSpec) (any, string, error) {
	v, err := rowStorage(raw, f)
	if err != nil || v == nil {
		return v, "", err
	}
	switch f.Kind {
	case FieldNumber:
		n, ok := sqliteFloat(v)
		if !ok {
			return nil, "storage_type", nil
		}
		if e := sqliteNumericError(n); e != "" {
			return nil, e, nil
		}
	case FieldText, FieldEnum:
		s, ok := v.(string)
		if ok && strings.ContainsRune(s, 0) {
			return nil, "", fmt.Errorf("%w: embedded NUL text", ErrRowsUnsupported)
		}
		if !ok {
			return nil, "storage_type", nil
		}
		if !utf8.ValidString(s) || len(s) > maxFormulaTextBytes {
			return nil, "text_range", nil
		}
	case FieldDatetime:
		if text, ok := v.(string); ok && strings.ContainsRune(text, 0) {
			return nil, "", fmt.Errorf("%w: datetime with embedded NUL", ErrRowsUnsupported)
		}
		value, code := sqliteV2Datetime(v, f.SQLiteDatetimeFormat)
		return value, code, nil
	case FieldBool:
		n, ok := v.(int64)
		if !ok || n != 0 && n != 1 {
			return nil, "storage_type", nil
		}
	}
	return v, "", nil
}

type rowMetricReduction struct {
	count   int64
	seen    map[string]struct{}
	numeric rowDecimalAggregate
	extreme any
	err     string
	// Distribution samples, kept until the first input error, and the NULL
	// and invalid inputs they exclude.
	samples        []float64
	sorted         bool
	nulls, invalid int64
}

func (r *rowMetricReduction) step(row map[string]any, m *rowMetricSpec) error {
	if m.op == "samples" {
		return r.sample(row, m)
	}
	if m.field == "" {
		r.count++
		return nil
	}
	v, code, err := rowMetricValue(row[m.field], &m.binding)
	if err != nil {
		return err
	}
	if m.op != "count" && v != nil && m.binding.Kind == FieldNumber {
		n, _ := sqliteFloat(v)
		if sqliteUnsafe(n) {
			code = "unsafe_integer"
			v = nil
		}
	}
	if code != "" {
		if r.err == "" || code < r.err {
			r.err = code
		}
		return nil
	}
	if v == nil {
		return nil
	}
	switch m.op {
	case "count":
		r.count++
	case "count_distinct":
		if r.seen == nil {
			r.seen = map[string]struct{}{}
		}
		key, text := v.(string)
		if !text {
			n, _ := sqliteFloat(v)
			if n == 0 {
				n = 0
			}
			key = strconv.FormatFloat(n, 'g', -1, 64)
		}
		r.seen[key] = struct{}{}
	case "sum", "avg":
		n, _ := sqliteFloat(v)
		r.numeric.add(n)
	case "min", "max":
		if r.extreme == nil || m.op == "min" && rowCompare(v, r.extreme) < 0 || m.op == "max" && rowCompare(v, r.extreme) > 0 {
			r.extreme = v
		}
	}
	return nil
}
func (r *rowMetricReduction) value(m *rowMetricSpec) (any, string, error) {
	if r.err != "" {
		return nil, r.err, nil
	}
	switch m.op {
	case "count":
		return float64(r.count), "", nil
	case "count_distinct":
		return float64(len(r.seen)), "", nil
	case "min", "max":
		v := r.extreme
		if n, ok := sqliteFloat(v); ok {
			return n, "", nil
		}
		return v, "", nil
	default:
		raw, err := r.numeric.value(m.op)
		if err != nil {
			return nil, "", err
		}
		var n sqliteNumericResult
		if err = json.Unmarshal([]byte(raw.(string)), &n); err != nil {
			return nil, "", err
		}
		if n.Value == nil {
			return nil, n.Error, nil
		}
		return *n.Value, n.Error, nil
	}
}

// sample matches the SQL population stage: an input error excludes the
// sample, and the group (box) or population (histogram) reports the least code.
func (r *rowMetricReduction) sample(row map[string]any, m *rowMetricSpec) error {
	v, code, err := rowMetricValue(row[m.field], &m.binding)
	if err != nil {
		return err
	}
	n, _ := sqliteFloat(v)
	if v != nil && sqliteUnsafe(n) {
		code = "unsafe_integer"
	}
	switch {
	case code != "":
		r.invalid++
		if r.err == "" || code < r.err {
			r.err = code
		}
		r.samples = nil
	case v == nil:
		r.nulls++
	case r.err == "":
		r.samples = append(r.samples, n)
	}
	return nil
}

// rowHistogram holds a histogram metric's edges over its whole population,
// before minCount and GroupLimit, or the error every group reports.
type rowHistogram struct {
	edges []float64
	err   string
}

func (c *rowMetricCohort) histogram(m *rowMetricSpec) *rowHistogram {
	h := &rowHistogram{edges: []float64{}}
	lo, hi, found := 0.0, 0.0, false
	for _, g := range c.groups {
		r := &g.reductions[m.reduction]
		if r.err != "" && (h.err == "" || r.err < h.err) {
			h.err = r.err
		}
		for _, v := range r.samples {
			if !found || v < lo {
				lo = v
			}
			if !found || v > hi {
				hi = v
			}
			found = true
		}
	}
	if h.err == "" && found {
		bins := m.spec.Distribution.Bins
		if bins == 0 {
			bins = 10
		}
		h.edges, h.err = distributionHistogramEdges(lo, hi, bins)
	}
	return h
}

// distribution returns one group's distribution bucket, without keys or count.
func (r *rowMetricReduction) distribution(m *rowMetricSpec, h *rowHistogram) SQLiteMetricV2Bucket {
	nulls, invalid := r.nulls, r.invalid
	b := SQLiteMetricV2Bucket{NullCount: &nulls, InputErrorCount: &invalid}
	if h != nil {
		if h.err != "" {
			b.Error = h.err
			return b
		}
		counts := make([]int64, max(len(h.edges)-1, 0))
		for _, v := range r.samples {
			counts[distributionHistogramBin(h.edges, v)]++
		}
		n := int64(len(r.samples))
		b.Value = float64(n)
		b.Distribution = &MetricHistogramDistribution{Kind: "histogram", Edges: append([]float64{}, h.edges...), Counts: counts, N: n}
		return b
	}
	if r.err != "" {
		b.Error = r.err
		return b
	}
	if len(r.samples) > SQLiteMaxBoxSamples {
		b.Error = "resource_limit"
		return b
	}
	if !r.sorted {
		sort.Float64s(r.samples)
		r.sorted = true
	}
	value, code, box := distributionBox(r.samples, m.spec.Distribution.Whiskers)
	if code != "" {
		b.Error = code
		return b
	}
	if value != nil {
		b.Value = *value
	}
	b.Distribution = box
	return b
}

func sortRowMetric(buckets []SQLiteMetricV2Bucket, spec AggSpec) {
	terms := append([]MetricSort{}, spec.Sort...)
	if len(terms) == 0 {
		terms = []MetricSort{{Key: "value", Dir: "desc"}}
	}
	seen := map[string]bool{}
	for _, term := range terms {
		seen[term.Key] = true
	}
	for i := range spec.GroupBy {
		name := "group" + strconv.Itoa(i)
		if !seen[name] {
			terms = append(terms, MetricSort{Key: name, Dir: "asc"})
		}
	}
	get := func(b SQLiteMetricV2Bucket, key string) any {
		if key == "value" {
			return b.Value
		}
		if key == "count" {
			return b.Count
		}
		if key == "samples" {
			return b.Count - *b.NullCount - *b.InputErrorCount
		}
		i, _ := strconv.Atoi(strings.TrimPrefix(key, "group"))
		return b.Keys[i]
	}
	sort.SliceStable(buckets, func(i, j int) bool {
		a, b := buckets[i], buckets[j]
		if (a.Error != "") != (b.Error != "") {
			return a.Error == ""
		}
		for _, term := range terms {
			av, bv := get(a, term.Key), get(b, term.Key)
			if av == nil && bv == nil {
				continue
			}
			if av == nil || bv == nil {
				if strings.EqualFold(term.Nulls, "first") {
					return av == nil
				}
				return bv == nil
			}
			cmp := rowCompare(av, bv)
			if cmp == 0 {
				continue
			}
			if term.Dir == "desc" {
				return cmp > 0
			}
			return cmp < 0
		}
		return false
	})
}
