package querytable

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strings"
)

// Exact percentiles over SQLite populations are hybrid. The reduction pass
// sorts each group in Go while it has at most sqliteInMemorySamples samples.
// A larger group overflows, and the same statement ranks the validated samples
// in SQL (ROW_NUMBER over the group's partition, ordered by sample) and reads
// only the samples at the ranks a percentile needs; Go interpolates those with
// the same IEEE operations as a sorted slice. Both paths give identical
// results, and the only size limits are the population and staging budgets.

// sqliteInMemorySamples is the largest group an in-memory percentile
// aggregate sorts in Go (eight bytes per sample, one group per aggregate at a
// time). A larger group reports rankedOverflow and the plan ranks that input
// in SQL instead, with identical results. Tests lower it to force ranking.
var sqliteInMemorySamples = SQLiteMaxMedianSamples

// rankedOverflow is the in-memory aggregates' result for a group above
// sqliteInMemorySamples. Plans compare against it; it never reaches a result.
const rankedOverflow = "qt_sample_overflow"

// TestOnlySetSQLiteInMemorySamples sets the in-memory group threshold and
// returns a function restoring the previous one, so parity suites outside this
// module can force the ranked SQL path. It exists only for those tests.
//
// Deprecated: test-only seam; hosts must not call it. Not safe for concurrent use.
func TestOnlySetSQLiteInMemorySamples(n int) (restore func()) {
	previous := sqliteInMemorySamples
	sqliteInMemorySamples = n
	return func() { sqliteInMemorySamples = previous }
}

// sqliteSamples collects one group's validated samples up to
// sqliteInMemorySamples, then drops them and reports overflow.
type sqliteSamples struct {
	samples  []float64
	overflow bool
	err      string
}

func (s *sqliteSamples) add(v driver.Value) {
	if v == nil || s.overflow || s.err != "" {
		return
	}
	n, ok := sqliteFloat(v)
	if !ok {
		s.err = "storage_type"
		return
	}
	if s.err = sqliteDistributionNumberError(n); s.err != "" {
		return
	}
	if len(s.samples) >= sqliteInMemorySamples {
		s.samples, s.overflow = nil, true
		return
	}
	s.samples = append(s.samples, n)
}

// sqliteSampleQuantileAggregate is the in-memory order statistic of a group
// that fits in memory, as REAL, TEXT error code or NULL; rankedOverflow
// otherwise. qt_v2_sample_median(sample) is MEDIAN's midpoint. Each row
// passes only its sample: per-row arguments are the dominant cost.
type sqliteSampleQuantileAggregate struct {
	sqliteSamples
	p        float64
	midpoint bool
}

func (a *sqliteSampleQuantileAggregate) Step(v []driver.Value) error {
	if len(v) != 1 {
		return fmt.Errorf("qt_v2_sample_median expects one argument")
	}
	a.add(v[0])
	return nil
}

func (a *sqliteSampleQuantileAggregate) Value() (driver.Value, error) {
	switch {
	case a.overflow:
		return rankedOverflow, nil
	case a.err != "":
		return a.err, nil
	case len(a.samples) == 0:
		return nil, nil
	}
	sort.Float64s(a.samples)
	n := int64(len(a.samples))
	if a.midpoint {
		return rankedResult(exactMidpoint(n, a.samples[(n-1)/2], a.samples[n/2])), nil
	}
	return rankedResult(sqlitePercentile(a.samples, a.p)), nil
}

// sqliteBoxSamplesAggregate is qt_v2_box_minmax(sample) or
// qt_v2_box_tukey(sample): the box payload of a group that fits in memory, or
// rankedOverflow.
type sqliteBoxSamplesAggregate struct {
	sqliteSamples
	whiskers string
}

func (a *sqliteBoxSamplesAggregate) Step(v []driver.Value) error {
	if len(v) != 1 {
		return fmt.Errorf("qt_v2_box_%s expects one argument", a.whiskers)
	}
	a.add(v[0])
	return nil
}

func (a *sqliteBoxSamplesAggregate) Value() (driver.Value, error) {
	if a.overflow {
		return rankedOverflow, nil
	}
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

// sqliteExactMeanAggregate is qt_v2_exact_mean(sample): distributionMean of
// the ranked path's samples, in any visitation order.
type sqliteExactMeanAggregate struct {
	sum exactSum
	n   int64
}

func (a *sqliteExactMeanAggregate) Step(v []driver.Value) error {
	if len(v) != 1 {
		return fmt.Errorf("qt_v2_exact_mean expects one argument")
	}
	if v[0] == nil {
		return nil
	}
	x, ok := sqliteFloat(v[0])
	if !ok {
		return fmt.Errorf("qt_v2_exact_mean expects numbers")
	}
	a.sum.add(x)
	a.n++
	return nil
}

func (a *sqliteExactMeanAggregate) Value() (driver.Value, error) {
	if a.n == 0 {
		return nil, nil
	}
	return a.sum.value() / float64(a.n), nil
}

// sqliteRankedAggregates are the in-memory percentile aggregates and the
// ranked path's exact mean.
func sqliteRankedAggregates() []SQLiteAggregateDescriptor {
	return []SQLiteAggregateDescriptor{
		{Name: "qt_v2_sample_median", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteSampleQuantileAggregate{midpoint: true} }},
		{Name: "qt_v2_box_minmax", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteBoxSamplesAggregate{whiskers: "minmax"} }},
		{Name: "qt_v2_box_tukey", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteBoxSamplesAggregate{whiskers: "tukey"} }},
		{Name: "qt_v2_exact_mean", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteExactMeanAggregate{} }},
	}
}

// exactLinearIndex is the zero-based lower sample index of the exact-linear
// p-percentile of n sorted samples. The upper index is min(lower+1, n-1).
func exactLinearIndex(n int64, p float64) int64 {
	return int64(math.Floor(float64(n-1) * p))
}

// exactLinear interpolates the p-percentile of n sorted samples from the
// samples a and b at the lower and upper indexes: (1-f)*a+f*b, rounding both
// products before the addition (no FMA), then clamping roundoff to [a,b].
func exactLinear(n int64, p, a, b float64) (float64, string) {
	position := float64(n-1) * p
	fraction := position - math.Floor(position)
	raw := float64(float64(1-fraction)*a) + float64(fraction*b)
	if e := sqliteDistributionNumberError(raw); e != "" {
		return 0, e
	}
	return min(b, max(a, raw)), ""
}

// exactMidpoint is MEDIAN's documented middle value: the middle sample, or the
// exact average of the middle two (decimal rationals of their shortest
// representations) rounded once to IEEE double.
func exactMidpoint(n int64, a, b float64) (float64, string) {
	exact := sqliteRat(a)
	if n%2 == 0 {
		exact.Add(exact, sqliteRat(b))
		exact.Quo(exact, big.NewRat(2, 1))
	}
	if e := sqliteRatError(exact); e != "" {
		return 0, e
	}
	v, _ := exact.Float64()
	if e := sqliteNumericError(v); e != "" {
		return 0, e
	}
	if sqliteUnsafe(v) {
		return 0, "unsafe_integer"
	}
	return v, ""
}

// rankedArguments reads a sample count and the samples at its percentile
// ranks. A missing sample is only valid for an empty population.
func rankedArguments(name string, a []driver.Value) (int64, []float64, error) {
	n, ok := a[0].(int64)
	if !ok || n < 0 {
		return 0, nil, fmt.Errorf("%s expects a sample count", name)
	}
	values := make([]float64, len(a)-1)
	for i, raw := range a[1:] {
		if n == 0 {
			continue
		}
		v, ok := sqliteFloat(raw)
		if !ok {
			return 0, nil, fmt.Errorf("%s expects ranked numeric samples", name)
		}
		values[i] = v
	}
	return n, values, nil
}

// rankedResult returns a valid number as REAL and an error as its TEXT code,
// so one call per group carries both; an empty population is NULL.
func rankedResult(value float64, code string) driver.Value {
	if code != "" {
		return code
	}
	return value
}

// sqliteRankedFunctions are scalar helpers called once per group.
func sqliteRankedFunctions() []SQLiteScalarFunction {
	return []SQLiteScalarFunction{
		// qt_v2_quantile(n, p, a, b): the exact-linear p-percentile of n samples,
		// given the samples at its lower and upper ranks.
		{Name: "qt_v2_quantile", Arity: 4, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != 4 {
				return nil, fmt.Errorf("qt_v2_quantile expects four arguments")
			}
			p, ok := sqliteFloat(a[1])
			if !ok || !(p >= 0 && p <= 1) {
				return nil, fmt.Errorf("qt_v2_quantile expects a probability")
			}
			n, v, err := rankedArguments("qt_v2_quantile", []driver.Value{a[0], a[2], a[3]})
			if err != nil || n == 0 {
				return nil, err
			}
			return rankedResult(exactLinear(n, p, v[0], v[1])), nil
		}},
		// qt_v2_midpoint(n, a, b): MEDIAN of n samples from its middle samples.
		{Name: "qt_v2_midpoint", Arity: 3, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != 3 {
				return nil, fmt.Errorf("qt_v2_midpoint expects three arguments")
			}
			n, v, err := rankedArguments("qt_v2_midpoint", a)
			if err != nil || n == 0 {
				return nil, err
			}
			return rankedResult(exactMidpoint(n, v[0], v[1])), nil
		}},
		// qt_v2_box_fence(n, q1a, q1b, q3a, q3b, side): the Tukey fence below
		// (side 0) or above (side 1) the quartiles, or NULL when a quartile fails.
		{Name: "qt_v2_box_fence", Arity: 6, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != 6 {
				return nil, fmt.Errorf("qt_v2_box_fence expects six arguments")
			}
			n, v, err := rankedArguments("qt_v2_box_fence", a[:5])
			side, ok := a[5].(int64)
			if err != nil || !ok || side != 0 && side != 1 {
				if err == nil {
					err = fmt.Errorf("qt_v2_box_fence expects a fence side")
				}
				return nil, err
			}
			if n == 0 {
				return nil, nil
			}
			q1, e1 := exactLinear(n, 0.25, v[0], v[1])
			q3, e3 := exactLinear(n, 0.75, v[2], v[3])
			if e1 != "" || e3 != "" {
				return nil, nil
			}
			low, high := tukeyFences(q1, q3)
			if side == 0 {
				return low, nil
			}
			return high, nil
		}},
		// qt_v2_box_summary(mode, n, min, max, mean, q1a, q1b, q2a, q2b, q3a,
		// q3b, low, high, outlier_count, outliers) returns the box payload of
		// one group, as the former qt_v2_box aggregate did.
		{Name: "qt_v2_box_summary", Arity: 15, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != 15 {
				return nil, fmt.Errorf("qt_v2_box_summary expects fifteen arguments")
			}
			mode, ok := a[0].(string)
			if !ok || mode != "minmax" && mode != "tukey" {
				return nil, fmt.Errorf("invalid whisker mode")
			}
			n, v, err := rankedArguments("qt_v2_box_summary", a[1:11])
			if err != nil {
				return nil, err
			}
			parts := boxParts{n: n}
			if n > 0 {
				parts.min, parts.max, parts.mean = v[0], v[1], v[2]
				for i := range parts.quartiles {
					parts.quartiles[i] = [2]float64{v[3+2*i], v[4+2*i]}
				}
				parts.low, parts.high = parts.min, parts.max
				if mode == "tukey" {
					parts.tukeyEmpty = a[11] == nil || a[12] == nil
					if !parts.tukeyEmpty {
						parts.low, _ = sqliteFloat(a[11])
						parts.high, _ = sqliteFloat(a[12])
					}
					count, _ := a[13].(int64)
					parts.outlierCount = count
					if text, ok := a[14].(string); ok {
						if err := json.Unmarshal([]byte(text), &parts.outliers); err != nil {
							return nil, fmt.Errorf("invalid ranked outliers")
						}
					}
				}
			}
			value, code, box := boxSummary(parts, mode)
			if box == nil {
				return sqliteDistributionJSON(nil, code, nil)
			}
			return sqliteDistributionJSON(value, code, box)
		}},
	}
}

// tukeyFences are the 1.5×IQR fences, rounding each operation like the browser.
func tukeyFences(q1, q3 float64) (float64, float64) {
	spread := float64(1.5 * float64(q3-q1))
	return q1 - spread, q3 + spread
}

// maxRankedOutliers bounds a box's outlier list: all outliers up to 20, else
// the ten lowest and ten highest.
const maxRankedOutliers = 20

// sqliteRankedValuesAggregate orders at most maxRankedOutliers (rank, value)
// pairs by rank and returns their values as a JSON array.
type sqliteRankedValuesAggregate struct {
	ranks  []int64
	values []float64
}

func (a *sqliteRankedValuesAggregate) Step(v []driver.Value) error {
	if len(v) != 2 {
		return fmt.Errorf("qt_v2_ranked_values expects two arguments")
	}
	rank, ok := v[0].(int64)
	value, valueOK := sqliteFloat(v[1])
	if !ok || !valueOK {
		return fmt.Errorf("qt_v2_ranked_values expects a rank and a number")
	}
	if len(a.ranks) >= maxRankedOutliers {
		return fmt.Errorf("qt_v2_ranked_values exceeds %d values", maxRankedOutliers)
	}
	a.ranks, a.values = append(a.ranks, rank), append(a.values, value)
	return nil
}

func (a *sqliteRankedValuesAggregate) Value() (driver.Value, error) {
	order := make([]int, len(a.ranks))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return a.ranks[order[i]] < a.ranks[order[j]] })
	values := make([]float64, len(order))
	for i, index := range order {
		values[i] = a.values[index]
	}
	text, err := json.Marshal(values)
	return string(text), err
}

// boxParts are one group's box statistics: the sample count, extrema and raw
// mean, the samples adjacent to each quartile position, and (for Tukey) the
// observed in-fence endpoints, the outlier count and the retained outliers.
type boxParts struct {
	n              int64
	min, max, mean float64
	quartiles      [3][2]float64
	low, high      float64
	tukeyEmpty     bool
	outlierCount   int64
	outliers       []float64
}

// boxSummary validates and assembles a box: the median value and box, or an
// error code. An empty population has no value and a null summary.
func boxSummary(p boxParts, mode string) (*float64, string, *MetricBoxDistribution) {
	if p.n == 0 {
		return nil, "", &MetricBoxDistribution{Kind: "box"}
	}
	q := make([]float64, 3)
	for i, prob := range []float64{0.25, 0.5, 0.75} {
		var e string
		q[i], e = exactLinear(p.n, prob, p.quartiles[i][0], p.quartiles[i][1])
		if e != "" {
			return nil, e, nil
		}
	}
	// Clamp roundoff to the observed range before validating: a mean of
	// samples at the range boundary may otherwise round just outside it.
	mean := min(p.max, max(p.min, p.mean))
	if e := sqliteDistributionNumberError(mean); e != "" {
		return nil, e, nil
	}
	if mode == "" {
		mode = "minmax"
	}
	s := &MetricBoxSummary{N: p.n, Min: p.min, Q1: q[0], Median: q[1], Q3: q[2], Max: p.max, Mean: mean, Low: p.min, High: p.max, Outliers: []float64{}, Whiskers: mode, Method: DistributionPrecision}
	if mode == "tukey" {
		if p.tukeyEmpty {
			return nil, "numeric_range", nil
		}
		s.Low, s.High, s.OutlierCount = p.low, p.high, p.outlierCount
		if p.outliers != nil {
			s.Outliers = p.outliers
		}
	}
	return &s.Median, "", &MetricBoxDistribution{Kind: "box", Summary: s}
}

// rankedSample is one percentile read from a ranked population: lo and hi
// map the SQL of the group's sample count n to the one-based ranks of the
// samples it interpolates.
type rankedSample struct{ lo, hi func(n string) string }

// medianRanks are MEDIAN's middle ranks; equal for odd n.
func medianRanks() rankedSample {
	return rankedSample{func(n string) string { return "(" + n + "-1)/2+1" }, func(n string) string { return n + "/2+1" }}
}

// quantileRanks are the exact-linear ranks of p. CAST truncates the IEEE
// product (n-1)*p, which is non-negative for a nonempty population, exactly
// as exactLinearIndex floors it.
func (b *planBuilder) quantileRanks(p float64) rankedSample {
	param := b.param(p, "double precision")
	lower := func(n string) string { return "CAST((" + n + "-1)*" + param + " AS INTEGER)+1" }
	return rankedSample{lower, func(n string) string { return "MIN(" + lower(n) + "+1," + n + ")" }}
}

// keysMatch joins two relations exposing the same group columns.
func keysMatch(left, right string, groupCols []string) string {
	terms := []string{}
	for _, column := range groupCols {
		terms = append(terms, left+"."+column+" IS "+right+"."+column)
	}
	if len(terms) == 0 {
		return "1"
	}
	return strings.Join(terms, " AND ")
}

// qualified prefixes each group column with a relation alias.
func qualified(alias string, groupCols []string) []string {
	out := []string{}
	for _, column := range groupCols {
		out = append(out, alias+"."+column)
	}
	return out
}

// sqliteRankedStage stages the non-NULL samples of population, ranked within
// each group: groupCols, sample, rn. Callers read it with the group's sample
// count, which they reduce natively. gate is an uncorrelated condition (some
// group overflowed its in-memory aggregate): SQLite evaluates it once before
// the scan, so a false gate skips the population and the window sort.
func (b *planBuilder) sqliteRankedStage(population, sample string, groupCols, groupExprs []string, materialized bool, gate string) string {
	selects := []string{}
	for i, column := range groupCols {
		selects = append(selects, groupExprs[i]+" AS "+column)
	}
	partition := ""
	if len(groupExprs) > 0 {
		partition = "PARTITION BY " + strings.Join(groupExprs, ",") + " "
	}
	selects = append(selects, sample+" AS sample", "ROW_NUMBER() OVER ("+partition+"ORDER BY "+sample+") AS rn")
	b.stage("SELECT " + strings.Join(selects, ",") + " FROM " + population + " WHERE " + gate + " AND " + sample + " IS NOT NULL")
	b.stages[len(b.stages)-1].Materialized = materialized
	return b.rel
}

// sqlitePickStage reads, per group of counts (a relation with groupCols and
// the count column n), the samples of ranked at each pick's lo and hi ranks,
// as pick<i>_lo and pick<i>_hi. Ranked rows drive the join, so each sample is
// visited once and probes the small grouped relation.
func (b *planBuilder) sqlitePickStage(ranked, counts, n string, groupCols []string, picks []rankedSample) string {
	selects := qualified("r", groupCols)
	ranks := []string{}
	for i, pick := range picks {
		lo, hi := pick.lo("c."+n), pick.hi("c."+n)
		selects = append(selects, fmt.Sprintf("MAX(CASE WHEN r.rn=%s THEN r.sample END) AS pick%d_lo", lo, i), fmt.Sprintf("MAX(CASE WHEN r.rn=%s THEN r.sample END) AS pick%d_hi", hi, i))
		ranks = append(ranks, lo, hi)
	}
	by := ""
	if len(groupCols) > 0 {
		by = " GROUP BY " + strings.Join(qualified("r", groupCols), ",")
	}
	b.stage("SELECT " + strings.Join(selects, ",") + " FROM " + ranked + " AS r CROSS JOIN " + counts + " AS c ON " + keysMatch("r", "c", groupCols) + " WHERE r.rn IN (" + strings.Join(ranks, ",") + ")" + by)
	return b.rel
}

// sqliteRankedLeaf is an order-statistic aggregate leaf: the reduction stage
// holds its in-memory result (alias_memory, from qt_v2_sample_median), its
// input error (alias_input); sqliteRankedLeaves
// adds its value (alias) and error (alias_error) columns, ranking in SQL only
// the groups whose in-memory result overflowed.
type sqliteRankedLeaf struct {
	// input identifies the leaf's row expression; leaves of one input share
	// a ranking (their validated sample columns are equivalent).
	alias, input, sample string
	ranks                rankedSample
	// midpoint selects MEDIAN's exact middle value; otherwise the leaf is
	// the exact-linear percentile p.
	midpoint bool
	p        string
}

// sqliteRankedLeaves ranks each distinct sample input of the leaves once per
// group of population, reads every rank its leaves need in one pass, and
// joins the interpolated values back to the reduction relation.
func (b *planBuilder) sqliteRankedLeaves(population string, groups []ValueSQL, leaves []sqliteRankedLeaf) {
	groupCols := groupOutput(len(groups))
	groupExprs := []string{}
	for _, g := range groups {
		groupExprs = append(groupExprs, g.Value, g.Error)
	}
	inputs, byInput := []string{}, map[string][]int{}
	for i, leaf := range leaves {
		if _, ok := byInput[leaf.input]; !ok {
			inputs = append(inputs, leaf.input)
		}
		byInput[leaf.input] = append(byInput[leaf.input], i)
	}
	reduced := b.rel
	joins, results := []string{}, []string{}
	for j, input := range inputs {
		members := byInput[input]
		overflowed := []string{}
		for _, i := range members {
			overflowed = append(overflowed, leaves[i].alias+"_memory IS '"+rankedOverflow+"'")
		}
		gate := "EXISTS (SELECT 1 FROM " + reduced + " WHERE " + strings.Join(overflowed, " OR ") + ")"
		rankedRel := b.sqliteRankedStage(population, leaves[members[0]].sample, groupCols, groupExprs, true, gate)
		// A ranked group's sample count is its largest rank.
		b.stage("SELECT " + strings.Join(append(qualified("r", groupCols), "MAX(r.rn) AS n"), ",") + " FROM " + rankedRel + " AS r" + groupedBy("r", groupCols))
		counts := b.rel
		picks := []rankedSample{}
		for _, i := range members {
			picks = append(picks, leaves[i].ranks)
		}
		picked := b.sqlitePickStage(rankedRel, counts, "n", groupCols, picks)
		alias, n := fmt.Sprintf("k%d", j), fmt.Sprintf("n%d", j)
		joins = append(joins, " LEFT JOIN "+picked+" AS "+alias+" ON "+keysMatch("c", alias, groupCols), " LEFT JOIN "+counts+" AS "+n+" ON "+keysMatch("c", n, groupCols))
		for k, i := range members {
			leaf := leaves[i]
			lo, hi := fmt.Sprintf("%s.pick%d_lo", alias, k), fmt.Sprintf("%s.pick%d_hi", alias, k)
			call := "qt_v2_quantile(" + n + ".n," + leaf.p + "," + lo + "," + hi + ")"
			if leaf.midpoint {
				call = "qt_v2_midpoint(" + n + ".n," + lo + "," + hi + ")"
			}
			memory := "c." + leaf.alias + "_memory"
			results = append(results, "CASE WHEN "+memory+" IS '"+rankedOverflow+"' THEN "+call+" ELSE "+memory+" END AS "+leaf.alias+"_result")
		}
	}
	b.stage("SELECT c.*," + strings.Join(results, ",") + " FROM " + reduced + " AS c" + strings.Join(joins, ""))
	// A result is a REAL value, a TEXT error code, or NULL for no samples.
	columns := []string{}
	for _, leaf := range leaves {
		result := leaf.alias + "_result"
		columns = append(columns, "CASE WHEN typeof("+result+")<>'text' THEN "+result+" END AS "+leaf.alias, "COALESCE("+leaf.alias+"_input,CASE WHEN typeof("+result+")='text' THEN "+result+" END) AS "+leaf.alias+"_error")
	}
	b.stage("SELECT *," + strings.Join(columns, ",") + " FROM " + b.rel)
}
