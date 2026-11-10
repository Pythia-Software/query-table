package querytable

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// MetricDistributionResult is the v2 wire union supported by both renderers.
type MetricDistributionResult interface{ metricDistributionResult() }

func (*MetricBoxDistribution) metricDistributionResult() {}

func (*MetricHistogramDistribution) metricDistributionResult() {}

// UnmarshalJSON reads the distribution union by its kind and keeps a
// present null y, so a decoded result re-encodes unchanged.
func (b *MetricBucket) UnmarshalJSON(data []byte) error {
	type plain MetricBucket
	var in struct {
		*plain
		Distribution json.RawMessage `json:"distribution"`
		Y            json.RawMessage `json:"y"`
	}
	in.plain = (*plain)(b)
	if err := json.Unmarshal(data, &in); err != nil {
		return err
	}
	b.Distribution, b.Y = nil, nil
	if in.Y != nil {
		var y any
		if err := json.Unmarshal(in.Y, &y); err != nil {
			return err
		}
		b.Y = &y
	}
	if in.Distribution == nil || string(in.Distribution) == "null" {
		return nil
	}
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(in.Distribution, &head); err != nil {
		return err
	}
	var target MetricDistributionResult
	switch head.Kind {
	case "box":
		target = &MetricBoxDistribution{}
	case "histogram":
		target = &MetricHistogramDistribution{}
	default:
		return fmt.Errorf("unknown distribution kind %q", head.Kind)
	}
	if err := json.Unmarshal(in.Distribution, target); err != nil {
		return err
	}
	b.Distribution = target
	return nil
}

// SQLiteMaxBoxSamples bounds the qt_v2_box aggregate, which compiled plans no
// longer call: SQLite boxes rank their samples in SQL without a per-group
// sample cap. It remains for hosts that call the aggregate directly.
//
// Deprecated: SQLite boxes are bounded by the population budgets only.
const SQLiteMaxBoxSamples = SQLiteMaxMedianSamples

type sqliteDistributionPayload struct {
	Value        *float64                 `json:"value"`
	Error        string                   `json:"error,omitempty"`
	Distribution MetricDistributionResult `json:"distribution,omitempty"`
}

func sqliteDistributionJSON(value *float64, code string, result MetricDistributionResult) (driver.Value, error) {
	returnJSON, err := json.Marshal(sqliteDistributionPayload{value, code, result})
	return string(returnJSON), err
}
func sqliteDistributionNumberError(n float64) string {
	if e := sqliteNumericError(n); e != "" {
		return e
	}
	if sqliteUnsafe(n) {
		return "unsafe_integer"
	}
	return ""
}

func sqliteDistributionFunctions() []SQLiteScalarFunction {
	return []SQLiteScalarFunction{{Name: "qt_v2_histogram_edges", Arity: 3, Call: func(a []driver.Value) (driver.Value, error) {
		if len(a) != 3 {
			return nil, fmt.Errorf("histogram edges expects three arguments")
		}
		bins, ok := a[2].(int64)
		if !ok || bins < 2 || bins > 30 {
			return nil, fmt.Errorf("histogram bins must be 2–30")
		}
		payload := sqliteHistogramEdges{Edges: []float64{}}
		if a[0] != nil || a[1] != nil {
			lo, lok := sqliteFloat(a[0])
			hi, hok := sqliteFloat(a[1])
			if !lok || !hok {
				return nil, fmt.Errorf("invalid histogram extent")
			}
			if lo > hi {
				return nil, fmt.Errorf("reversed histogram extent")
			}
			payload.Edges, payload.Error = distributionHistogramEdges(lo, hi, int(bins))
		}
		data, e := json.Marshal(payload)
		return string(data), e
	}}}
}

// distributionHistogramEdges returns the shared edges of a nonempty extent, or
// an error code and no edges.
func distributionHistogramEdges(lo, hi float64, bins int) ([]float64, string) {
	if e := sqliteDistributionNumberError(lo); e != "" {
		return []float64{}, e
	}
	if e := sqliteDistributionNumberError(hi); e != "" {
		return []float64{}, e
	}
	if lo == hi {
		return []float64{lo, hi}, ""
	}
	edges := make([]float64, bins+1)
	for i := range edges {
		// Round the product before addition to match the frontend (no FMA).
		ratio := float64(i) / float64(bins)
		offset := float64(float64(hi-lo) * ratio)
		edge := lo + offset
		if i == 0 {
			edge = lo
		}
		if i == bins {
			edge = hi
		}
		edges[i] = edge
		if e := sqliteDistributionNumberError(edge); e != "" {
			return []float64{}, e
		}
		if i > 0 && edge <= edges[i-1] {
			return []float64{}, "histogram_precision"
		}
	}
	return edges, ""
}

// distributionHistogramBin is the half-open bin of v; the final bin also
// includes the maximum. v must lie within edges, which has at least two.
func distributionHistogramBin(edges []float64, v float64) int {
	return sort.Search(len(edges)-2, func(i int) bool { return v < edges[i+1] })
}

type sqliteHistogramEdges struct {
	Edges []float64 `json:"edges"`
	Error string    `json:"error,omitempty"`
}

func sqliteDistributionAggregates() []SQLiteAggregateDescriptor {
	return []SQLiteAggregateDescriptor{
		{Name: "qt_v2_box", Arity: 2, New: func() SQLiteAggregateFunction { return &sqliteBoxAggregate{} }},
		{Name: "qt_v2_histogram", Arity: 2, New: func() SQLiteAggregateFunction { return &sqliteHistogramAggregate{} }},
		{Name: "qt_v2_ranked_values", Arity: 2, New: func() SQLiteAggregateFunction { return &sqliteRankedValuesAggregate{} }},
	}
}

// Step only validates and appends; the summary, including the mean, is
// computed once from the sorted samples.
type sqliteBoxAggregate struct {
	samples       []float64
	whiskers, err string
}

func (a *sqliteBoxAggregate) Step(values []driver.Value) error {
	if len(values) != 2 {
		return fmt.Errorf("box expects two arguments")
	}
	mode, ok := values[1].(string)
	if !ok || (mode != "minmax" && mode != "tukey") {
		return fmt.Errorf("invalid whisker mode")
	}
	if a.whiskers != "" && a.whiskers != mode {
		return fmt.Errorf("inconsistent whisker mode")
	}
	a.whiskers = mode
	if values[0] == nil || a.err != "" {
		return nil
	}
	n, ok := sqliteFloat(values[0])
	if !ok {
		a.err = "storage_type"
		return nil
	}
	if a.err = sqliteDistributionNumberError(n); a.err != "" {
		return nil
	}
	if len(a.samples) >= SQLiteMaxBoxSamples {
		a.err = "resource_limit"
		a.samples = nil
		return nil
	}
	a.samples = append(a.samples, n)
	return nil
}
func sqlitePercentile(sorted []float64, p float64) (float64, string) {
	n := int64(len(sorted))
	lower := exactLinearIndex(n, p)
	return exactLinear(n, p, sorted[lower], sorted[min(lower+1, n-1)])
}

// distributionMean is the compensated (Neumaier) mean of finite samples. Each
// sample is at most 1e100 in magnitude, so the running sum cannot overflow.
func distributionMean(samples []float64) float64 {
	sum, compensation := 0.0, 0.0
	for _, v := range samples {
		t := sum + v
		if math.Abs(sum) >= math.Abs(v) {
			compensation += (sum - t) + v
		} else {
			compensation += (v - t) + sum
		}
		sum = t
	}
	return (sum + compensation) / float64(len(samples))
}
func (a *sqliteBoxAggregate) Value() (driver.Value, error) {
	if a.err != "" {
		return sqliteDistributionJSON(nil, a.err, nil)
	}
	sort.Float64s(a.samples)
	value, code, box := distributionBox(a.samples, a.whiskers)
	if box == nil {
		return sqliteDistributionJSON(nil, code, nil)
	}
	return sqliteDistributionJSON(value, code, box)
}

// distributionBox summarizes sorted, validated samples: the median value and
// box, or an error code. An empty population has no value and no summary.
func distributionBox(samples []float64, mode string) (*float64, string, *MetricBoxDistribution) {
	n := len(samples)
	parts := boxParts{n: int64(n)}
	if n == 0 {
		return boxSummary(parts, mode)
	}
	parts.min, parts.max, parts.mean = samples[0], samples[n-1], distributionMean(samples)
	for i, p := range []float64{0.25, 0.5, 0.75} {
		lower := exactLinearIndex(parts.n, p)
		parts.quartiles[i] = [2]float64{samples[lower], samples[min(lower+1, parts.n-1)]}
	}
	if mode == "tukey" {
		q1, e1 := sqlitePercentile(samples, 0.25)
		q3, e3 := sqlitePercentile(samples, 0.75)
		if e1 == "" && e3 == "" {
			lowFence, highFence := tukeyFences(q1, q3)
			first := sort.Search(n, func(i int) bool { return samples[i] >= lowFence })
			end := sort.Search(n, func(i int) bool { return samples[i] > highFence })
			parts.tukeyEmpty = first >= end
			if !parts.tukeyEmpty {
				parts.low, parts.high = samples[first], samples[end-1]
			}
			parts.outlierCount = int64(first + n - end)
			total := int(parts.outlierCount)
			parts.outliers = []float64{}
			for i := 0; i < min(total, maxRankedOutliers); i++ {
				rank := i
				if total > maxRankedOutliers && i >= maxRankedOutliers/2 {
					rank = total - maxRankedOutliers + i
				}
				index := rank
				if rank >= first {
					index = end + rank - first
				}
				parts.outliers = append(parts.outliers, samples[index])
			}
		}
	}
	return boxSummary(parts, mode)
}

type sqliteHistogramAggregate struct {
	initialized bool
	config      string
	edges       []float64
	counts      []int64
	n           int64
	err         string
}

func (a *sqliteHistogramAggregate) Step(values []driver.Value) error {
	if len(values) != 2 {
		return fmt.Errorf("histogram expects two arguments")
	}
	config, ok := values[1].(string)
	if !ok {
		return fmt.Errorf("histogram edges must be JSON text")
	}
	if !a.initialized {
		var p sqliteHistogramEdges
		if len(config) > 10000 || json.Unmarshal([]byte(config), &p) != nil {
			return fmt.Errorf("invalid histogram edges")
		}
		if len(p.Edges) > 31 || len(p.Edges) == 1 {
			return fmt.Errorf("invalid histogram edge count")
		}
		for i, e := range p.Edges {
			if code := sqliteDistributionNumberError(e); code != "" {
				return fmt.Errorf("invalid histogram edge: %s", code)
			}
			if i > 0 && (e < p.Edges[i-1] || e == p.Edges[i-1] && len(p.Edges) != 2) {
				return fmt.Errorf("unordered histogram edges")
			}
		}
		a.config = config
		a.edges = p.Edges
		if a.edges == nil {
			a.edges = []float64{}
		}
		a.counts = make([]int64, max(len(a.edges)-1, 0))
		a.err = p.Error
		a.initialized = true
	} else if a.config != config {
		return fmt.Errorf("inconsistent histogram edges")
	}
	if values[0] == nil || a.err != "" {
		return nil
	}
	v, ok := sqliteFloat(values[0])
	if !ok {
		a.err = "storage_type"
		return nil
	}
	if a.err = sqliteDistributionNumberError(v); a.err != "" {
		return nil
	}
	if len(a.edges) == 0 || v < a.edges[0] || v > a.edges[len(a.edges)-1] {
		return fmt.Errorf("sample falls outside shared histogram edges")
	}
	a.counts[distributionHistogramBin(a.edges, v)]++
	a.n++
	return nil
}
func (a *sqliteHistogramAggregate) Value() (driver.Value, error) {
	if a.err != "" {
		return sqliteDistributionJSON(nil, a.err, nil)
	}
	edges, counts := a.edges, a.counts
	if edges == nil {
		edges = []float64{}
	}
	if counts == nil {
		counts = []int64{}
	}
	n := float64(a.n)
	return sqliteDistributionJSON(&n, "", &MetricHistogramDistribution{Kind: "histogram", Edges: edges, Counts: counts, N: a.n})
}

// sqliteBox stages each group's box payload from its ranked samples: native
// counts, extrema and mean; the samples at the quartile ranks; for Tukey, the
// tail counts outside the fences, the samples at the in-fence endpoint ranks
// and at most maxRankedOutliers outliers. Only the ranked relation is as large
// as the population; every other stage has one row per group.
func (b *planBuilder) sqliteBox(population string, groupCols, inventory []string, by, mode string) {
	modeParam := b.param(mode, "text")
	// SQLite AVG compensates its sum (Kahan-Babuska-Neumaier, SQLite 3.43+).
	b.stage("SELECT " + strings.Join(append(inventory, "MIN(sample_error) AS input_error", "MIN(sample) AS min", "MAX(sample) AS max", "AVG(sample) AS mean"), ",") + " FROM " + population + by)
	stats := b.rel
	ranked := b.sqliteRankedStage(population, "sample", groupCols, groupCols, mode == "tukey")
	picks := []rankedSample{}
	for _, p := range []float64{0.25, 0.5, 0.75} {
		picks = append(picks, b.quantileRanks(p))
	}
	picked := b.sqlitePickStage(ranked, stats, "samples", groupCols, picks)
	b.stage("SELECT s.*,k.pick0_lo,k.pick0_hi,k.pick1_lo,k.pick1_hi,k.pick2_lo,k.pick2_hi FROM " + stats + " AS s LEFT JOIN " + picked + " AS k ON " + keysMatch("s", "k", groupCols))
	quartiles := "pick0_lo,pick0_hi,pick1_lo,pick1_hi,pick2_lo,pick2_hi"
	tukey := "NULL,NULL,0,NULL"
	if mode == "tukey" {
		b.stage("SELECT *,qt_v2_box_fence(samples,pick0_lo,pick0_hi,pick2_lo,pick2_hi,0) AS low_fence,qt_v2_box_fence(samples,pick0_lo,pick0_hi,pick2_lo,pick2_hi,1) AS high_fence FROM " + b.rel)
		fenced := b.rel
		// Only samples outside the fences reach the grouped tail count.
		b.stage("SELECT " + strings.Join(append(qualified("r", groupCols), "COUNT(*) FILTER (WHERE r.sample<f.low_fence) AS low_n", "COUNT(*) FILTER (WHERE r.sample>f.high_fence) AS high_n"), ",") + " FROM " + ranked + " AS r CROSS JOIN " + fenced + " AS f ON " + keysMatch("r", "f", groupCols) + " WHERE r.sample<f.low_fence OR r.sample>f.high_fence" + groupedBy("r", groupCols))
		tails := b.rel
		b.stage("SELECT f.*,COALESCE(t.low_n,0) AS low_n,COALESCE(t.high_n,0) AS high_n FROM " + fenced + " AS f LEFT JOIN " + tails + " AS t ON " + keysMatch("f", "t", groupCols))
		counted := b.rel
		// Outlier j of the combined sorted list (lower tail, then upper tail)
		// is kept when it is among the first or last maxRankedOutliers/2.
		lowTail, highTail := "r.rn<=g.low_n", "r.rn>g.samples-g.high_n"
		index := "CASE WHEN " + lowTail + " THEN r.rn-1 ELSE g.low_n+r.rn-(g.samples-g.high_n)-1 END"
		half := fmt.Sprint(maxRankedOutliers / 2)
		kept := "(" + lowTail + " OR " + highTail + ") AND (" + index + "<" + half + " OR " + index + ">=g.low_n+g.high_n-" + half + ")"
		lowRank, highRank := "g.low_n+1", "g.samples-g.high_n"
		b.stage("SELECT " + strings.Join(append(qualified("r", groupCols), "MAX(CASE WHEN r.rn="+lowRank+" THEN r.sample END) AS low", "MAX(CASE WHEN r.rn="+highRank+" THEN r.sample END) AS high", "qt_v2_ranked_values(r.rn,r.sample) FILTER (WHERE "+kept+") AS outliers"), ",") + " FROM " + ranked + " AS r CROSS JOIN " + counted + " AS g ON " + keysMatch("r", "g", groupCols) + " WHERE r.rn=" + lowRank + " OR r.rn=" + highRank + " OR (" + kept + ")" + groupedBy("r", groupCols))
		ends := b.rel
		b.stage("SELECT g.*,CASE WHEN g.low_n+g.high_n<g.samples THEN e.low END AS low,CASE WHEN g.low_n+g.high_n<g.samples THEN e.high END AS high,e.outliers FROM " + counted + " AS g LEFT JOIN " + ends + " AS e ON " + keysMatch("g", "e", groupCols))
		tukey = "low,high,low_n+high_n,outliers"
	}
	b.stage("SELECT " + strings.Join(append(append([]string{}, groupCols...), "count", "samples", "null_count", "input_error_count", "input_error", "qt_v2_box_summary("+modeParam+",samples,min,max,mean,"+quartiles+","+tukey+") AS payload"), ",") + " FROM " + b.rel)
}

func groupedBy(alias string, groupCols []string) string {
	if len(groupCols) == 0 {
		return ""
	}
	return " GROUP BY " + strings.Join(qualified(alias, groupCols), ",")
}

func (b *planBuilder) sqliteDistribution(spec AggSpec, groups []ValueSQL, scope string) (SQLPlan, error) {
	d := spec.Distribution
	if d.Kind != "box" && d.Kind != "histogram" {
		return SQLPlan{}, diagnostic(ErrorCodeDistribution, "unknown distribution kind")
	}
	if d.Kind == "histogram" && len(groups) > 1 {
		return SQLPlan{}, diagnostic(ErrorCodeDistribution, "histograms support at most one grouping key")
	}
	if d.Whiskers != "" && d.Whiskers != "minmax" && d.Whiskers != "tukey" {
		return SQLPlan{}, diagnostic(ErrorCodeDistribution, "unknown whisker mode")
	}
	bins := d.Bins
	if bins == 0 {
		bins = 10
	}
	if bins < 2 || bins > 30 {
		return SQLPlan{}, diagnostic(ErrorCodeDistribution, "histogram bins must be 2–30")
	}
	if spec.ExpressionY != "" || spec.Display != nil && spec.Display.Kind == "scatter" {
		return SQLPlan{}, diagnostic(ErrorCodeDistribution, "distributions cannot be paired metrics")
	}
	n, e := parseExpression(d.Input)
	if e != nil {
		return SQLPlan{}, e
	}
	v, e := b.row(n)
	if e != nil {
		return SQLPlan{}, e
	}
	if e = requireType(v, "number"); e != nil {
		return SQLPlan{}, e
	}
	if e = b.aggregatePolicy(n, d.Kind, map[string]bool{}); e != nil {
		return SQLPlan{}, e
	}
	v = b.metricNumber(v)
	selects := []string{}
	errors := []string{v.Error}
	cols := []OutputColumn{}
	for i, g := range groups {
		name := fmt.Sprintf("group%d", i)
		selects = append(selects, g.Value+" AS "+name, g.Error+" AS "+name+"_error")
		errors = append(errors, g.Error)
		cols = append(cols, OutputColumn{Field: spec.GroupBy[i], ValueAlias: name, Type: g.Type})
	}
	selects = append(selects, v.Value+" AS sample", "COALESCE("+strings.Join(append(errors, "NULL"), ",")+") AS sample_error")
	b.stage("SELECT " + strings.Join(selects, ",") + " FROM " + b.rel)
	population := b.rel
	groupCols := groupOutput(len(groups))
	by := ""
	if len(groupCols) > 0 {
		by = " GROUP BY " + strings.Join(groupCols, ",")
	}
	inventory := append(append([]string{}, groupCols...), "COUNT(*) AS count", "COUNT(sample) AS samples", "COUNT(*) FILTER (WHERE sample IS NULL AND sample_error IS NULL) AS null_count", "COUNT(*) FILTER (WHERE sample_error IS NOT NULL) AS input_error_count")
	if d.Kind == "box" {
		mode := d.Whiskers
		if mode == "" {
			mode = "minmax"
		}
		b.sqliteBox(population, groupCols, inventory, by, mode)
	} else {
		b.stage("SELECT qt_v2_histogram_edges(MIN(sample),MAX(sample)," + b.param(bins, "integer") + ") AS edges,MIN(sample_error) AS input_error FROM " + population)
		b.stage("SELECT edges,COALESCE(input_error,json_extract(edges,'$.error')) AS extent_error FROM " + b.rel)
		extent := b.rel
		selects = append(inventory, "COALESCE(MIN(extent_error),MIN(sample_error)) AS input_error", "qt_v2_histogram(sample,edges) AS payload")
		b.stage("SELECT " + strings.Join(selects, ",") + " FROM " + population + " CROSS JOIN " + extent + by)
	}
	b.stage("SELECT *,COALESCE(input_error,json_extract(payload,'$.error')) AS error FROM " + b.rel)
	selects = append(append([]string{}, groupCols...), "count", "samples", "null_count", "input_error_count", "error", "CASE WHEN error IS NULL THEN json_extract(payload,'$.value') END AS value", "CASE WHEN error IS NULL THEN json_extract(payload,'$.distribution') END AS distribution")
	b.stage("SELECT " + strings.Join(selects, ",") + " FROM " + b.rel)
	order, e := metricOrder(spec, len(groups), false, true)
	if e != nil {
		return SQLPlan{}, e
	}
	sql := b.metricResult(spec, order)
	cols = append(cols, OutputColumn{ValueAlias: "value", Type: "number"})
	return b.finish(sql, scope, cols), nil
}
