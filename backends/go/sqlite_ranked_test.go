package querytable

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func rankedFunction(t *testing.T, name string) func(...driver.Value) (driver.Value, error) {
	t.Helper()
	for _, f := range SQLiteV2Functions() {
		if f.Name == name {
			return func(a ...driver.Value) (driver.Value, error) { return f.Call(a) }
		}
	}
	t.Fatal("unregistered", name)
	return nil
}

func TestExactLinearMatchesSortedPercentile(t *testing.T) {
	random := rand.New(rand.NewSource(7))
	for trial := 0; trial < 2000; trial++ {
		samples := make([]float64, 1+random.Intn(40))
		for i := range samples {
			samples[i] = float64(random.Intn(200)-100) / float64(1+random.Intn(9))
		}
		sort.Float64s(samples)
		n := int64(len(samples))
		for _, p := range []float64{0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1, random.Float64()} {
			lower := exactLinearIndex(n, p)
			upper := min(lower+1, n-1)
			got, code := exactLinear(n, p, samples[lower], samples[upper])
			want, wantCode := sqlitePercentile(samples, p)
			if got != want || code != wantCode {
				t.Fatal(samples, p, got, want)
			}
		}
	}
	// (1-f)*a+f*b with both products rounded: position (4-1)*0.1 between 0 and 0.1.
	p, b := 0.1, 0.1
	if v, code := exactLinear(4, p, 0, b); code != "" || v != float64(3)*p*b || v != 0.030000000000000006 {
		t.Fatal(v, code)
	}
	if _, code := exactLinear(2, 0.5, -1e-300, 1e-300); code != "" {
		t.Fatal(code)
	}
	if _, code := exactLinear(3, 0.25, -2e-300, 1e-300); code != "numeric_range" {
		t.Fatal(code)
	}
}

func TestExactMidpointKeepsMedianDefinition(t *testing.T) {
	for _, c := range []struct {
		n    int64
		a, b float64
		want float64
		code string
	}{
		// The decimal midpoint of 0.1 and 0.2, not IEEE (0.1+0.2)/2.
		{2, 0.1, 0.2, 0.15, ""},
		{3, 0.1, 0.2, 0.1, ""},
		{2, 9007199254740990, 9007199254740992, 9007199254740991, ""},
		{2, 9007199254740991, 9007199254740993, 0, "unsafe_integer"},
		{2, -1e-300, 1e-300, 0, ""},
		{2, 1e-300, 1.5e-300, 1.25e-300, ""},
	} {
		got, code := exactMidpoint(c.n, c.a, c.b)
		if got != c.want || code != c.code {
			t.Fatal(c, got, code)
		}
	}
}

func TestRankedFunctions(t *testing.T) {
	quantile, midpoint, fence := rankedFunction(t, "qt_v2_quantile"), rankedFunction(t, "qt_v2_midpoint"), rankedFunction(t, "qt_v2_box_fence")
	for _, c := range []struct {
		got, want driver.Value
	}{
		{must(quantile(int64(4), 0.25, int64(0), 10.0)), 7.5},
		{must(quantile(int64(0), 0.25, nil, nil)), nil},
		{must(quantile(int64(1), 1.0, int64(3), int64(3))), 3.0},
		{must(quantile(int64(3), 0.25, -2e-300, 1e-300)), "numeric_range"},
		{must(midpoint(int64(2), 0.1, 0.2)), 0.15},
		{must(midpoint(int64(0), nil, nil)), nil},
		{must(midpoint(int64(2), int64(9007199254740991), 9007199254740993.0)), "unsafe_integer"},
		// [0,10,20,30]: q1 7.5, q3 22.5, spread 22.5.
		{must(fence(int64(4), int64(0), int64(10), int64(20), int64(30), int64(0))), -15.0},
		{must(fence(int64(4), int64(0), int64(10), int64(20), int64(30), int64(1))), 45.0},
		{must(fence(int64(0), nil, nil, nil, nil, int64(1))), nil},
	} {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Fatalf("got %#v want %#v", c.got, c.want)
		}
	}
	for _, args := range [][]driver.Value{{"4", 0.5, 1.0, 2.0}, {int64(4), 1.5, 1.0, 2.0}, {int64(4), 0.5, "x", 2.0}, {int64(-1), 0.5, 1.0, 2.0}} {
		if _, err := quantile(args...); err == nil {
			t.Fatal("accepted", args)
		}
	}
	if _, err := fence(int64(4), int64(0), int64(10), int64(20), int64(30), int64(2)); err == nil {
		t.Fatal("accepted fence side")
	}
}

func must(v driver.Value, err error) driver.Value {
	if err != nil {
		panic(err)
	}
	return v
}

func TestRankedValuesOrderAndBound(t *testing.T) {
	a := &sqliteRankedValuesAggregate{}
	for _, row := range [][]driver.Value{{int64(9), 3.5}, {int64(1), int64(-2)}, {int64(5), 0.0}} {
		if err := a.Step(row); err != nil {
			t.Fatal(err)
		}
	}
	if v, err := a.Value(); err != nil || v != "[-2,0,3.5]" {
		t.Fatal(v, err)
	}
	if v, _ := (&sqliteRankedValuesAggregate{}).Value(); v != "[]" {
		t.Fatal(v)
	}
	full := &sqliteRankedValuesAggregate{}
	for i := 0; i < maxRankedOutliers; i++ {
		if err := full.Step([]driver.Value{int64(i), 1.0}); err != nil {
			t.Fatal(err)
		}
	}
	if err := full.Step([]driver.Value{int64(99), 1.0}); err == nil {
		t.Fatal("accepted more than the outlier bound")
	}
}

// The ranked box summary agrees with the sorted-slice box for any population.
func TestBoxSummaryFunctionMatchesSortedBox(t *testing.T) {
	summary := rankedFunction(t, "qt_v2_box_summary")
	random := rand.New(rand.NewSource(11))
	for trial := 0; trial < 500; trial++ {
		samples := make([]float64, 1+random.Intn(60))
		for i := range samples {
			samples[i] = float64(random.Intn(100) - 50)
			if random.Intn(10) == 0 {
				samples[i] *= 1000
			}
		}
		sort.Float64s(samples)
		n := int64(len(samples))
		for _, mode := range []string{"minmax", "tukey", "percentile"} {
			percentiles := [2]float64{0.1, 0.9}
			value, code, box := distributionBox(samples, mode, percentiles)
			want, _ := sqliteDistributionJSON(value, code, box)
			args := []driver.Value{mode, n, samples[0], samples[n-1], distributionMean(samples)}
			for _, p := range []float64{0.25, 0.5, 0.75} {
				lower := exactLinearIndex(n, p)
				args = append(args, samples[lower], samples[min(lower+1, n-1)])
			}
			if mode == "tukey" && box != nil {
				s := box.Summary
				text, _ := json.Marshal([]float64(s.Outliers))
				args = append(args, s.Low, s.High, s.OutlierCount, string(text))
			} else if mode == "percentile" {
				low, _ := sqlitePercentile(samples, percentiles[0])
				high, _ := sqlitePercentile(samples, percentiles[1])
				outside := int64(0)
				for _, v := range samples {
					if v < low || v > high {
						outside++
					}
				}
				args = append(args, low, high, outside, "[0.1,0.9]")
			} else {
				args = append(args, nil, nil, int64(0), nil)
			}
			if got := must(summary(args...)); got != want {
				t.Fatalf("%s %v\ngot  %s\nwant %s", mode, samples, got, want)
			}
		}
	}
}

// In-memory aggregates reserve slice capacity from the process-wide budget,
// overflow when it is exhausted, and return their reservation once valued.
func TestInMemorySampleBudget(t *testing.T) {
	if sqliteInMemoryReserved.Load() != 0 {
		t.Fatal("leaked reservation", sqliteInMemoryReserved.Load())
	}
	restore := TestOnlySetSQLiteInMemorySamples(3 * sqliteSampleChunk)
	defer restore()
	a := &sqliteSampleQuantileAggregate{midpoint: true}
	for i := 0; i < 2*sqliteSampleChunk; i++ {
		if err := a.Step([]driver.Value{float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if a.overflow || sqliteInMemoryReserved.Load() != 2*sqliteSampleChunk {
		t.Fatal("reserved", sqliteInMemoryReserved.Load())
	}
	// A second live group gets the remaining chunk, then overflows.
	b := &sqliteBoxSamplesAggregate{whiskers: "minmax"}
	for i := 0; i < 2*sqliteSampleChunk; i++ {
		if err := b.Step([]driver.Value{float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if !b.overflow || sqliteInMemoryReserved.Load() != 2*sqliteSampleChunk {
		t.Fatal("overflow", b.overflow, sqliteInMemoryReserved.Load())
	}
	if v, _ := b.Value(); v != rankedOverflow {
		t.Fatal(v)
	}
	if v, _ := a.Value(); v != float64(sqliteSampleChunk)-0.5 {
		t.Fatal(v)
	}
	if sqliteInMemoryReserved.Load() != 0 {
		t.Fatal("not released", sqliteInMemoryReserved.Load())
	}
}

func TestSQLiteSampleLimitDefaults(t *testing.T) {
	for dialect, want := range map[string]int{"sqlite": sqliteDirectPopulation, "postgres": DefaultMaxSamplesPerGroup} {
		if got, err := (QueryDatasetV3{Dialect: dialect}).sampleLimit(); err != nil || got != want {
			t.Fatal(dialect, got, err)
		}
		if got, _ := (QueryDatasetV3{Dialect: dialect, MaxSamplesPerGroup: 7}).sampleLimit(); got != 7 {
			t.Fatal(dialect, got)
		}
	}
}

// Every MEDIAN and PERCENTILE of one input reads one ranking per group;
// another input ranks separately.
func TestRankedLeavesShareOneRanking(t *testing.T) {
	s := sqliteTestSchema()
	s.Fields["n"] = FieldSpec{Name: "n", Kind: FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true}
	for expression, rankings := range map[string]int{
		"PERCENTILE([n], 0.1) + PERCENTILE([n], 0.9) - MEDIAN([n])": 1,
		"PERCENTILE([n], 0.9) - PERCENTILE([n] * 2, 0.9)":           2,
	} {
		p, err := compileMetricOutputs(context.Background(), metricRequest{Version: 2}, AggSpec{ID: "p", Expression: expression, GroupBy: []string{"text"}}, s, PlanOptions{SourceSQL: "SELECT * FROM fixture"}, true, nil)
		if err != nil {
			t.Fatal(expression, err)
		}
		if got := strings.Count(p.SQL, "ROW_NUMBER()"); got != rankings {
			t.Fatal(expression, got, p.SQL)
		}
	}
	for expression, code := range map[string]ErrorCode{
		"PERCENTILE([n])":         ErrorCodeArity,
		"PERCENTILE([n], 2)":      ErrorCodeTypeError,
		"PERCENTILE([n], -0.1)":   ErrorCodeTypeError,
		"PERCENTILE([n], [n])":    ErrorCodeTypeError,
		"PERCENTILE([text], 0.5)": ErrorCodeTypeError,
	} {
		for _, sqlite := range []bool{true, false} {
			_, err := compileMetricOutputs(context.Background(), metricRequest{Version: 2}, AggSpec{ID: "p", Expression: expression}, s, PlanOptions{SourceSQL: "SELECT * FROM fixture"}, sqlite, nil)
			var diag *PlanDiagnostic
			if !errors.As(err, &diag) || diag.Code != code {
				t.Fatal(expression, sqlite, err)
			}
		}
	}
}

func TestQuantilesPayloadReadsOnlyItsRanks(t *testing.T) {
	samples := []float64{-5, 0, 0, 2, 7.5, 9, 40}
	probabilities := []float64{0, 0.1, 0.5, 0.95, 1}
	ranks := quantileRankList(int64(len(samples)), probabilities)
	if !reflect.DeepEqual(ranks, []int64{1, 2, 4, 5, 6, 7}) {
		t.Fatal(ranks)
	}
	read := map[int64]bool{}
	value, code, d := quantilesPayload(int64(len(samples)), probabilities, func(rank int64) (float64, bool) {
		read[rank] = true
		return samples[rank-1], true
	})
	if code != "" || *value != 2 || len(read) != len(ranks) {
		t.Fatal(code, value, read)
	}
	for i, p := range probabilities {
		if want, _ := sqlitePercentile(samples, p); d.Summary.Values[i] != want {
			t.Fatal(p, d.Summary.Values[i], want)
		}
	}
	if value, code, d := quantilesPayload(0, probabilities, nil); value != nil || code != "" || d.Summary != nil {
		t.Fatal(value, code, d)
	}
	ranksFn := rankedFunction(t, "qt_v2_quantile_ranks")
	if got := must(ranksFn(int64(7), "[0,0.1,0.5,0.95,1]")); got != "[1,2,4,5,6,7]" {
		t.Fatal(got)
	}
	for _, bad := range []string{"[]", "[0.5,0.5]", "[1.5]", "x"} {
		if _, err := ranksFn(int64(7), bad); err == nil {
			t.Fatal("accepted", bad)
		}
	}
}

func TestValidateDistributionOptions(t *testing.T) {
	for _, d := range []MetricDistribution{
		{Kind: "box", Input: "[n]", Whiskers: "percentile", WhiskerProbabilities: []float64{0.25, 0.9}},
		{Kind: "box", Input: "[n]", Whiskers: "percentile", WhiskerProbabilities: []float64{0.1, 0.75}},
		{Kind: "box", Input: "[n]", Whiskers: "percentile", WhiskerProbabilities: []float64{0.1}},
		{Kind: "box", Input: "[n]", Whiskers: "other"},
		{Kind: "quantiles", Input: "[n]"},
		{Kind: "quantiles", Input: "[n]", Probabilities: []float64{0.2, 0.1}},
	} {
		if _, err := validateDistribution(&d, 1); err == nil {
			t.Fatalf("accepted %+v", d)
		}
	}
	// Options of another kind or whisker mode are inactive and ignored.
	for _, d := range []MetricDistribution{
		{Kind: "box", Input: "[n]", Whiskers: "percentile"},
		{Kind: "box", Input: "[n]", Whiskers: "percentile", WhiskerProbabilities: []float64{0, 1}},
		{Kind: "quantiles", Input: "[n]", Probabilities: []float64{0, 0.5, 1}},
		{Kind: "box", Input: "[n]", Whiskers: "tukey", WhiskerProbabilities: []float64{0.5, 0.5}, Probabilities: []float64{0.5, 0.2}},
		{Kind: "histogram", Input: "[n]", Whiskers: "tukey"},
		{Kind: "quantiles", Input: "[n]", Whiskers: "percentile", WhiskerProbabilities: []float64{0.1, 0.9}, Probabilities: []float64{0.5}},
	} {
		if _, err := validateDistribution(&d, 1); err != nil {
			t.Fatal(d, err)
		}
	}
}

// Distributions are not scalar aggregate ops: a field with an explicit op
// allowlist admits every kind, as it admits boxes and histograms.
func TestDistributionKindsIgnoreAggregateOps(t *testing.T) {
	s := sqliteTestSchema()
	s.Fields["n"] = FieldSpec{Name: "n", Kind: FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true, AggregateOps: []string{"avg"}}
	for _, kind := range []string{"box", "histogram", "quantiles"} {
		for _, sqlite := range []bool{true, false} {
			spec := AggSpec{ID: "d", Op: "count", Distribution: &MetricDistribution{Kind: kind, Input: "[n]", Probabilities: []float64{0.5}}}
			if _, err := compileMetricOutputs(context.Background(), metricRequest{Version: 2}, spec, s, PlanOptions{SourceSQL: "SELECT * FROM fixture"}, sqlite, nil); err != nil {
				t.Fatal(kind, sqlite, err)
			}
		}
	}
}
