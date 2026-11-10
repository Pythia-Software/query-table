package querytable

import (
	"cmp"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
)

// Exact percentiles over SQLite populations are hybrid. The reduction pass
// sorts each group in Go while the process-wide in-memory sample budget
// (sqliteInMemorySamples) has room for it. A group that does not fit
// overflows, and the same statement ranks the validated samples in SQL
// (ROW_NUMBER over the group's partition, ordered by sample) and reads only
// the samples at the ranks a percentile needs; Go interpolates those with the
// same IEEE operations as a sorted slice. Both paths give identical results,
// and the only size limits are the population and sample budgets.

// sqliteInMemorySamples bounds the samples all in-memory percentile
// aggregates of the process retain at once (8 bytes each, counted by slice
// capacity): 8,388,608 samples, 64 MiB. SQLite reduces groups one at a time
// per aggregate, so a statement normally holds one group per order-statistic
// input; concurrent statements share the budget. A group that cannot reserve
// room reports rankedOverflow and the plan ranks it in SQL instead, with
// identical results. Tests lower it to force ranking.
var sqliteInMemorySamples int64 = 8 << 20

// sqliteInMemoryReserved is the capacity the live in-memory aggregates hold.
var sqliteInMemoryReserved atomic.Int64

// rankedOverflow is the in-memory aggregates' result for a group that did not
// fit. Plans compare against it; it never reaches a result.
const rankedOverflow = "qt_sample_overflow"

// TestOnlySetSQLiteInMemorySamples sets the process-wide in-memory sample
// budget and returns a function restoring the previous one, so parity suites
// outside this module can force the ranked SQL path. It exists only for
// those tests.
//
// Deprecated: test-only seam; hosts must not call it. Not safe for concurrent use.
func TestOnlySetSQLiteInMemorySamples(n int) (restore func()) {
	previous := sqliteInMemorySamples
	sqliteInMemorySamples = int64(n)
	return func() { sqliteInMemorySamples = previous }
}

// sqliteSampleChunk is the smallest capacity a group reserves at a time.
const sqliteSampleChunk = 4096

// sqliteSamples collects one group's validated samples while the in-memory
// budget has room, then drops them and reports overflow. It must be the
// first field of its aggregate, whose finalizer returns an abandoned
// reservation (SQLite may discard an aggregate without asking its value).
type sqliteSamples struct {
	samples  []float64
	reserved int64
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
	if len(s.samples) == cap(s.samples) {
		grow := int64(max(sqliteSampleChunk, cap(s.samples)))
		if sqliteInMemoryReserved.Add(grow) > sqliteInMemorySamples {
			sqliteInMemoryReserved.Add(-grow)
			s.release()
			s.overflow = true
			return
		}
		if s.reserved == 0 {
			runtime.SetFinalizer(s, (*sqliteSamples).release)
		}
		s.reserved += grow
		grown := make([]float64, len(s.samples), int64(cap(s.samples))+grow)
		copy(grown, s.samples)
		s.samples = grown
	}
	s.samples = append(s.samples, n)
}

// release returns the group's reservation; Value calls it once done.
func (s *sqliteSamples) release() {
	if s.reserved != 0 {
		sqliteInMemoryReserved.Add(-s.reserved)
		s.reserved = 0
	}
	s.samples = nil
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
	defer a.release()
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

// sqliteSampleQuantilesAggregate is qt_v2_sample_quantiles(sample, spec):
// every order statistic of one input from one in-memory sort. spec is a JSON
// array of probabilities, -1 for MEDIAN's midpoint. The result is a JSON
// array of numbers, error codes and nulls for qt_v2_sample_pick, or
// rankedOverflow.
type sqliteSampleQuantilesAggregate struct {
	sqliteSamples
	spec string
}

func (a *sqliteSampleQuantilesAggregate) Step(v []driver.Value) error {
	spec, ok := v[1].(string)
	if len(v) != 2 || !ok || a.spec != "" && a.spec != spec {
		return fmt.Errorf("qt_v2_sample_quantiles expects a sample and one specification")
	}
	a.spec = spec
	a.add(v[0])
	return nil
}

func (a *sqliteSampleQuantilesAggregate) Value() (driver.Value, error) {
	defer a.release()
	if a.overflow {
		return rankedOverflow, nil
	}
	var spec []float64
	if a.spec != "" && json.Unmarshal([]byte(a.spec), &spec) != nil {
		return nil, fmt.Errorf("invalid sample quantile specification")
	}
	sort.Float64s(a.samples)
	n := int64(len(a.samples))
	results := make([]any, len(spec))
	for i, p := range spec {
		var value float64
		var code string
		switch {
		case a.err != "":
			results[i] = a.err
			continue
		case n == 0:
			continue
		case p < 0:
			value, code = exactMidpoint(n, a.samples[(n-1)/2], a.samples[n/2])
		default:
			value, code = sqlitePercentile(a.samples, p)
		}
		results[i] = rankedResult(value, code)
	}
	text, err := json.Marshal(results)
	return string(text), err
}

// sqliteBoxSamplesAggregate is qt_v2_box_minmax(sample) or
// qt_v2_box_tukey(sample): the box payload of a group that fits in memory, or
// rankedOverflow.
type sqliteBoxSamplesAggregate struct {
	sqliteSamples
	whiskers    string
	percentiles [2]float64
}

// Step reads the sample, and for qt_v2_box_percentile(sample, lo, hi) the
// whisker probabilities.
func (a *sqliteBoxSamplesAggregate) Step(v []driver.Value) error {
	arity := 1
	if a.whiskers == "percentile" {
		arity = 3
	}
	if len(v) != arity {
		return fmt.Errorf("qt_v2_box_%s expects %d arguments", a.whiskers, arity)
	}
	if arity == 3 {
		lo, loOK := sqliteFloat(v[1])
		hi, hiOK := sqliteFloat(v[2])
		if !loOK || !hiOK || !(lo >= 0 && lo < 0.25 && hi > 0.75 && hi <= 1) {
			return fmt.Errorf("qt_v2_box_percentile expects whisker probabilities")
		}
		a.percentiles = [2]float64{lo, hi}
	}
	a.add(v[0])
	return nil
}

func (a *sqliteBoxSamplesAggregate) Value() (driver.Value, error) {
	defer a.release()
	if a.overflow {
		return rankedOverflow, nil
	}
	if a.err != "" {
		return sqliteDistributionJSON(nil, a.err, nil)
	}
	sort.Float64s(a.samples)
	value, code, box := distributionBox(a.samples, a.whiskers, a.percentiles)
	if box == nil {
		return sqliteDistributionJSON(nil, code, nil)
	}
	return sqliteDistributionJSON(value, code, box)
}

// sqliteQuantilesSamplesAggregate is qt_v2_quantiles_samples(sample,
// probabilities): the quantile payload of a group that fits in memory, or
// rankedOverflow.
type sqliteQuantilesSamplesAggregate struct {
	sqliteSamples
	probabilities string
}

func (a *sqliteQuantilesSamplesAggregate) Step(v []driver.Value) error {
	text, ok := v[1].(string)
	if len(v) != 2 || !ok || a.probabilities != "" && a.probabilities != text {
		return fmt.Errorf("qt_v2_quantiles_samples expects a sample and one probability list")
	}
	a.probabilities = text
	a.add(v[0])
	return nil
}

func (a *sqliteQuantilesSamplesAggregate) Value() (driver.Value, error) {
	if a.overflow {
		return rankedOverflow, nil
	}
	if a.err != "" {
		return sqliteDistributionJSON(nil, a.err, nil)
	}
	probabilities, err := sqliteProbabilities(a.probabilities)
	if err != nil {
		return nil, err
	}
	sort.Float64s(a.samples)
	value, code, d := quantilesPayload(int64(len(a.samples)), probabilities, func(rank int64) (float64, bool) {
		return a.samples[rank-1], true
	})
	if d == nil {
		return sqliteDistributionJSON(nil, code, nil)
	}
	return sqliteDistributionJSON(value, code, d)
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
		{Name: "qt_v2_sample_quantiles", Arity: 2, New: func() SQLiteAggregateFunction { return &sqliteSampleQuantilesAggregate{} }},
		{Name: "qt_v2_box_minmax", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteBoxSamplesAggregate{whiskers: "minmax"} }},
		{Name: "qt_v2_box_tukey", Arity: 1, New: func() SQLiteAggregateFunction { return &sqliteBoxSamplesAggregate{whiskers: "tukey"} }},
		{Name: "qt_v2_box_percentile", Arity: 3, New: func() SQLiteAggregateFunction { return &sqliteBoxSamplesAggregate{whiskers: "percentile"} }},
		{Name: "qt_v2_quantiles_samples", Arity: 2, New: func() SQLiteAggregateFunction { return &sqliteQuantilesSamplesAggregate{} }},
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
	return append(sqliteQuantileFunctions(), []SQLiteScalarFunction{
		// qt_v2_sample_pick(results, i): term i of qt_v2_sample_quantiles, as
		// REAL, TEXT error code or NULL; rankedOverflow stays rankedOverflow.
		{Name: "qt_v2_sample_pick", Arity: 2, Call: func(a []driver.Value) (driver.Value, error) {
			text, ok := a[0].(string)
			i, indexOK := a[1].(int64)
			if len(a) != 2 || !indexOK || a[0] != nil && !ok {
				return nil, fmt.Errorf("qt_v2_sample_pick expects sample quantiles and an index")
			}
			if a[0] == nil || text == rankedOverflow {
				return a[0], nil
			}
			var results []any
			if json.Unmarshal([]byte(text), &results) != nil || i < 0 || int(i) >= len(results) {
				return nil, fmt.Errorf("invalid sample quantiles")
			}
			return results[i], nil
		}},
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
		// one group, as the former qt_v2_box aggregate did. Percentile boxes
		// pass their [lo, hi] whisker probabilities, as JSON, in place of the
		// outliers they never list.
		{Name: "qt_v2_box_summary", Arity: 15, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != 15 {
				return nil, fmt.Errorf("qt_v2_box_summary expects fifteen arguments")
			}
			mode, ok := a[0].(string)
			if !ok || mode != "minmax" && mode != "tukey" && mode != "percentile" {
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
				if mode == "percentile" {
					// qt_v2_quantile results: a REAL whisker or a TEXT error code.
					for i, target := range []*float64{&parts.low, &parts.high} {
						if code, ok := a[11+i].(string); ok {
							parts.whiskerError = cmp.Or(parts.whiskerError, code)
						} else if x, ok := sqliteFloat(a[11+i]); ok {
							*target = x
						} else {
							return nil, fmt.Errorf("invalid percentile whisker")
						}
					}
					parts.outlierCount, _ = a[13].(int64)
					text, _ := a[14].(string)
					if err := json.Unmarshal([]byte(text), &parts.probabilities); err != nil || len(parts.probabilities) != 2 {
						return nil, fmt.Errorf("invalid whisker probabilities")
					}
				}
			}
			value, code, box := boxSummary(parts, mode)
			if box == nil {
				return sqliteDistributionJSON(nil, code, nil)
			}
			return sqliteDistributionJSON(value, code, box)
		}},
	}...)
}

// quantileRanks lists the distinct one-based ranks the exact-linear
// percentiles of n samples read, for every probability and the median.
func quantileRankList(n int64, probabilities []float64) []int64 {
	seen := map[int64]bool{}
	ranks := []int64{}
	for _, p := range append(append([]float64{}, probabilities...), 0.5) {
		lower := exactLinearIndex(n, p)
		for _, rank := range []int64{lower + 1, min(lower+1, n-1) + 1} {
			if !seen[rank] {
				seen[rank] = true
				ranks = append(ranks, rank)
			}
		}
	}
	sort.Slice(ranks, func(i, j int) bool { return ranks[i] < ranks[j] })
	return ranks
}

// quantilesPayload is one group's quantile distribution and median value
// from its samples by one-based rank, or an error code.
func quantilesPayload(n int64, probabilities []float64, at func(rank int64) (float64, bool)) (*float64, string, *MetricQuantilesDistribution) {
	if n == 0 {
		return nil, "", &MetricQuantilesDistribution{Kind: "quantiles"}
	}
	percentile := func(p float64) (float64, string) {
		lower := exactLinearIndex(n, p)
		a, okA := at(lower + 1)
		b, okB := at(min(lower+1, n-1) + 1)
		if !okA || !okB {
			return 0, "missing_rank"
		}
		return exactLinear(n, p, a, b)
	}
	values := make([]float64, len(probabilities))
	for i, p := range probabilities {
		var code string
		if values[i], code = percentile(p); code != "" {
			return nil, code, nil
		}
	}
	median, code := percentile(0.5)
	if code != "" {
		return nil, code, nil
	}
	return &median, "", &MetricQuantilesDistribution{Kind: "quantiles", Summary: &MetricQuantilesSummary{N: n, Probabilities: append([]float64{}, probabilities...), Values: values}}
}

func sqliteProbabilities(value driver.Value) ([]float64, error) {
	text, ok := value.(string)
	var probabilities []float64
	if !ok || len(text) > 10000 || json.Unmarshal([]byte(text), &probabilities) != nil || !validQuantileProbabilities(probabilities) {
		return nil, fmt.Errorf("invalid quantile probabilities")
	}
	return probabilities, nil
}

// sqliteQuantileFunctions read a quantile distribution's ranks per group.
func sqliteQuantileFunctions() []SQLiteScalarFunction {
	return []SQLiteScalarFunction{
		// qt_v2_quantile_ranks(n, probabilities): a JSON array of the ranks.
		{Name: "qt_v2_quantile_ranks", Arity: 2, Call: func(a []driver.Value) (driver.Value, error) {
			n, ok := a[0].(int64)
			probabilities, err := sqliteProbabilities(a[1])
			if !ok || n < 0 || err != nil {
				return nil, cmp.Or(err, fmt.Errorf("qt_v2_quantile_ranks expects a sample count"))
			}
			ranks := []int64{}
			if n > 0 {
				ranks = quantileRankList(n, probabilities)
			}
			text, err := json.Marshal(ranks)
			return string(text), err
		}},
		// qt_v2_quantiles_summary(n, probabilities, samples): the payload of
		// one group from qt_v2_rank_samples' [rank, sample] pairs.
		{Name: "qt_v2_quantiles_summary", Arity: 3, Call: func(a []driver.Value) (driver.Value, error) {
			n, ok := a[0].(int64)
			probabilities, err := sqliteProbabilities(a[1])
			if !ok || n < 0 || err != nil {
				return nil, cmp.Or(err, fmt.Errorf("qt_v2_quantiles_summary expects a sample count"))
			}
			samples := map[int64]float64{}
			if text, ok := a[2].(string); ok {
				var pairs [][2]float64
				if json.Unmarshal([]byte(text), &pairs) != nil {
					return nil, fmt.Errorf("invalid ranked samples")
				}
				for _, pair := range pairs {
					samples[int64(pair[0])] = pair[1]
				}
			}
			value, code, distribution := quantilesPayload(n, probabilities, func(rank int64) (float64, bool) {
				v, ok := samples[rank]
				return v, ok
			})
			if code == "missing_rank" {
				return nil, fmt.Errorf("a quantile rank has no sample")
			}
			if distribution == nil {
				return sqliteDistributionJSON(nil, code, nil)
			}
			return sqliteDistributionJSON(value, code, distribution)
		}},
	}
}

// maxRankSamples bounds qt_v2_rank_samples: two ranks for each of at most
// 101 probabilities and the median.
const maxRankSamples = 2 * (maxQuantileProbabilities + 1)

// sqliteRankSamplesAggregate collects [rank, sample] pairs as a JSON array.
type sqliteRankSamplesAggregate struct{ pairs [][2]float64 }

func (a *sqliteRankSamplesAggregate) Step(v []driver.Value) error {
	if len(v) != 2 {
		return fmt.Errorf("qt_v2_rank_samples expects two arguments")
	}
	rank, ok := v[0].(int64)
	value, valueOK := sqliteFloat(v[1])
	if !ok || !valueOK || len(a.pairs) >= maxRankSamples {
		return fmt.Errorf("qt_v2_rank_samples expects at most %d ranked numbers", maxRankSamples)
	}
	a.pairs = append(a.pairs, [2]float64{float64(rank), value})
	return nil
}

func (a *sqliteRankSamplesAggregate) Value() (driver.Value, error) {
	if a.pairs == nil {
		a.pairs = [][2]float64{}
	}
	text, err := json.Marshal(a.pairs)
	return string(text), err
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
	// whiskerError fails percentile whiskers whose interpolation failed;
	// probabilities are their [lo, hi].
	whiskerError  string
	probabilities []float64
	outlierCount  int64
	outliers      []float64
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
	switch mode {
	case "tukey":
		if p.tukeyEmpty {
			return nil, "numeric_range", nil
		}
		s.Low, s.High, s.OutlierCount = p.low, p.high, p.outlierCount
		if p.outliers != nil {
			s.Outliers = p.outliers
		}
	case "percentile":
		// Interpolated whiskers; samples beyond them are counted, not listed.
		if p.whiskerError != "" {
			return nil, p.whiskerError, nil
		}
		s.Low, s.High, s.OutlierCount = p.low, p.high, p.outlierCount
		s.WhiskerProbabilities = p.probabilities
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
// The bound probability parameter is returned for the interpolation.
func (b *planBuilder) quantileRanks(p float64) (rankedSample, string) {
	param := b.param(p, "double precision")
	lower := func(n string) string { return "CAST((" + n + "-1)*" + param + " AS INTEGER)+1" }
	return rankedSample{lower, func(n string) string { return "MIN(" + lower(n) + "+1," + n + ")" }}, param
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
// holds its input's in-memory result (see sqliteMemoryColumns) and its
// input error (alias_input); sqliteRankedLeaves
// adds its value (alias) and error (alias_error) columns, ranking in SQL only
// the groups whose in-memory result overflowed.
type sqliteRankedLeaf struct {
	// input identifies the leaf's row expression; leaves of one input share
	// a ranking (their validated sample columns are equivalent).
	alias, input, sample string
	ranks                rankedSample
	// midpoint selects MEDIAN's exact middle value; otherwise the leaf is
	// the exact-linear percentile probability (bound as p).
	midpoint    bool
	probability float64
	p           string
	// memory is the leaf's in-memory result and overflow the column whose
	// rankedOverflow marks a group to rank; see sqliteMemoryColumns.
	memory, overflow string
}

// sqliteMemoryColumns returns the reduction columns sorting each distinct
// input of the leaves in memory, and sets each leaf's memory and overflow.
// A lone MEDIAN uses qt_v2_sample_median, whose rows pass only the sample.
// Otherwise one qt_v2_sample_quantiles sorts the group once for every
// PERCENTILE and MEDIAN of that input, and qt_v2_sample_pick reads each.
func (b *planBuilder) sqliteMemoryColumns(leaves []sqliteRankedLeaf) []string {
	inputs, byInput := []string{}, map[string][]int{}
	for i, leaf := range leaves {
		if _, ok := byInput[leaf.input]; !ok {
			inputs = append(inputs, leaf.input)
		}
		byInput[leaf.input] = append(byInput[leaf.input], i)
	}
	columns := []string{}
	for j, input := range inputs {
		members := byInput[input]
		column := fmt.Sprintf("m%d_memory", j)
		sample := leaves[members[0]].sample
		if len(members) == 1 && leaves[members[0]].midpoint {
			columns = append(columns, "qt_v2_sample_median("+sample+") AS "+column)
			leaves[members[0]].memory, leaves[members[0]].overflow = "c."+column, column
			continue
		}
		spec := []float64{}
		for k, i := range members {
			p := leaves[i].probability
			if leaves[i].midpoint {
				p = -1
			}
			spec = append(spec, p)
			leaves[i].memory, leaves[i].overflow = fmt.Sprintf("qt_v2_sample_pick(c.%s,%d)", column, k), column
		}
		encoded, _ := json.Marshal(spec)
		columns = append(columns, "qt_v2_sample_quantiles("+sample+","+b.param(string(encoded), "text")+") AS "+column)
	}
	return columns
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
		// One in-memory result per input, so one overflow column.
		gate := "EXISTS (SELECT 1 FROM " + reduced + " WHERE " + leaves[members[0]].overflow + " IS '" + rankedOverflow + "')"
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
			results = append(results, "CASE WHEN c."+leaf.overflow+" IS '"+rankedOverflow+"' THEN "+call+" ELSE "+leaf.memory+" END AS "+leaf.alias+"_result")
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
