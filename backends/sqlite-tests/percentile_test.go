package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// percentilePopulation stages size+30 numbers: a permutation of 0..size-1
// plus fifteen low (-1,000,015..-1,000,001) and fifteen high
// (1,000,001..1,000,015) outliers. Sorted, index j holds j-15 for 15<=j<size+15.
// Every row has group "all"; parity groups the permutation into "even" and
// "odd" values, and the outliers into "low" and "high". size must be coprime
// to 104729, which is prime.
func percentilePopulation(t *testing.T, size int) (*sql.DB, qt.QueryDatasetV3) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "percentiles.db")))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(`CREATE TABLE big(id TEXT PRIMARY KEY, n INTEGER, g TEXT, parity TEXT);
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?1)
INSERT INTO big SELECT 'r'||i,(i*104729)%?1,'all',CASE WHEN (i*104729)%?1%2=0 THEN 'even' ELSE 'odd' END FROM s;
WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<15)
INSERT INTO big SELECT 'low'||i,-1000000-i,'all','low' FROM k UNION ALL SELECT 'high'||i,1000000+i,'all','high' FROM k;`, size); err != nil {
		t.Fatal(err)
	}
	schema := qt.Schema{Name: "big", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":     {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true},
		"n":      {Name: "n", Kind: qt.FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true},
		"g":      {Name: "g", Kind: qt.FieldEnum, Expr: "r.g", Sortable: true},
		"parity": {Name: "parity", Kind: qt.FieldEnum, Expr: "r.parity", Sortable: true},
	}}
	return db, qt.QueryDatasetV3{Dialect: "sqlite", Schema: schema, SourceSQL: "SELECT * FROM big", MaxPopulation: size + 30}
}

// percentileSampleSize is the permutation size of the single-group test:
// 250,000 samples, or 2,000 under the race detector, which slows the pure-Go
// SQLite driver tenfold.
func percentileSampleSize() int {
	if raceEnabled {
		return 2000
	}
	return 250000
}

// One group far above the former 100,000-sample cap reduces exactly: MEDIAN,
// min/max and Tukey boxes, with the default executor (MEDIAN sorted in
// memory, direct in-memory boxes) and grouped by a constant key in the staged
// executor with no in-memory budget (ranked SQL throughout).
func TestPercentilesWithoutSampleCap(t *testing.T) {
	size := percentileSampleSize()
	db, d := percentilePopulation(t, size)
	n := size + 30
	// The sorted population: fifteen low outliers, 0..size-1, fifteen high.
	at := func(j int) float64 {
		switch {
		case j < 15:
			return float64(-1000015 + j)
		case j < size+15:
			return float64(j - 15)
		}
		return float64(1000001 + j - size - 15)
	}
	quantile := func(p float64) float64 {
		position := float64(n-1) * p
		lower := math.Floor(position)
		fraction := position - lower
		a, b := at(int(lower)), at(min(int(lower)+1, n-1))
		return float64(float64(1-fraction)*a) + float64(fraction*b)
	}
	low, high := []float64{}, []float64{}
	for i := 15; i >= 6; i-- {
		low = append(low, float64(-1000000-i))
	}
	for i := 6; i <= 15; i++ {
		high = append(high, float64(1000000+i))
	}
	median := (at(n/2-1) + at(n/2)) / 2
	// The outliers cancel: the sum is that of 0..size-1.
	mean := float64(size*(size-1)/2) / float64(n)
	base := qt.MetricBoxSummary{N: int64(n), Min: -1000015, Q1: quantile(0.25), Median: quantile(0.5), Q3: quantile(0.75), Max: 1000015, Mean: mean, Method: "exact-linear"}
	if base.Median != median || base.Q1 != float64(size)/4-7.75 {
		t.Fatal("closed form", base, median)
	}
	minmax := base
	minmax.Low, minmax.High, minmax.Outliers, minmax.Whiskers = -1000015, 1000015, []float64{}, "minmax"
	tukey := base
	tukey.Low, tukey.High, tukey.Outliers, tukey.OutlierCount, tukey.Whiskers = 0, float64(size-1), append(low, high...), 30, "tukey"
	for _, run := range []struct {
		dataset  qt.QueryDatasetV3
		grouping []string
		ranked   bool
	}{{d, nil, false}, {qt.TestOnlyStageUngrouped(d), []string{"g"}, true}} {
		restore := func() {}
		if run.ranked {
			restore = qt.TestOnlySetSQLiteInMemorySamples(0)
		}
		q := metricsV3(nil, nil, 0, 0,
			qt.AggSpec{ID: "median", Expression: "MEDIAN([n])", GroupBy: run.grouping},
			qt.AggSpec{ID: "minmax", Op: "count", GroupBy: run.grouping, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
			qt.AggSpec{ID: "tukey", Op: "count", GroupBy: run.grouping, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]", Whiskers: "tukey"}},
		)
		r, err := run.dataset.Execute(context.Background(), db, q, qt.PlanOptions{})
		restore()
		if err != nil {
			t.Fatal(run.grouping, err)
		}
		for _, m := range r.Metrics {
			if m.Error != "" || len(m.Buckets) != 1 || m.Buckets[0].Error != "" || m.Buckets[0].Count != int64(n) {
				t.Fatal(run.grouping, mustJSON(t, m))
			}
		}
		if v := r.Metrics[0].Buckets[0].Value; v != median {
			t.Fatal(run.grouping, "median", v, median)
		}
		for i, want := range []qt.MetricBoxSummary{minmax, tukey} {
			got := r.Metrics[i+1].Buckets[0].Distribution.(*qt.MetricBoxDistribution).Summary
			if !reflect.DeepEqual(*got, want) {
				t.Fatalf("%v %s\ngot  %+v\nwant %+v", run.grouping, r.Metrics[i+1].ID, *got, want)
			}
		}
	}
}

// Several large groups rank independently: the ranked SQL plans agree with
// the in-memory direct reducer and with each group computed alone.
func TestPercentilesRankEachGroup(t *testing.T) {
	size := 20000
	if raceEnabled {
		size = 2000
	}
	db, d := percentilePopulation(t, size)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	q := metricsV3(nil, nil, 0, 0,
		qt.AggSpec{ID: "median", Expression: "MEDIAN([n])", GroupBy: []string{"parity"}},
		qt.AggSpec{ID: "tukey", Op: "count", GroupBy: []string{"parity"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]", Whiskers: "tukey"}},
	)
	compareStaged(t, tx, d, q, qt.PlanOptions{})
	compareDirect(t, tx, d, q)
	got := executeV3Tx(t, tx, d, q, qt.PlanOptions{})
	medians := map[any]any{}
	for _, b := range got.Metrics[0].Buckets {
		medians[b.Keys[0]] = b.Value
	}
	// Even values 0..size-2 and odd values 1..size-1, size/2 of each.
	if !reflect.DeepEqual(medians, map[any]any{"even": float64(size/2 - 1), "odd": float64(size / 2), "low": -1000008.0, "high": 1000008.0}) {
		t.Fatal(medians)
	}
}

// Groups sorted in memory and groups ranked in SQL give identical results:
// the same plans run with the default in-memory threshold and with a zero
// threshold that ranks every group, for MEDIAN and both box whiskers, over
// integral and fractional samples, nulls, invalid samples and empty groups.
func TestPercentilesInMemoryAndRankedAgree(t *testing.T) {
	// The race detector slows the pure-Go SQLite driver tenfold.
	size := 3000
	if raceEnabled {
		size = 300
	}
	db, d := percentilePopulation(t, size)
	metrics := []qt.AggSpec{}
	// The last input is NULL for every permutation value: empty groups.
	for i, input := range []string{"[n]", "[n] / 7", "[n] / ([n] - 5)", "IF([n] < -2000000, [n], NULL)"} {
		for _, grouping := range [][]string{nil, {"parity"}} {
			id := fmt.Sprintf("%d_%d", i, len(grouping))
			metrics = append(metrics, percentileAgreementMetrics(id, input, grouping)...)
		}
	}
	staged := qt.TestOnlyStageUngrouped(d)
	run := func() string {
		out := ""
		for start := 0; start < len(metrics); start += 20 {
			r, err := staged.Execute(context.Background(), db, metricsV3(nil, nil, 0, 0, metrics[start:min(start+20, len(metrics))]...), qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			out += mustJSON(t, r.Metrics)
		}
		return out
	}
	memory := run()
	restore := qt.TestOnlySetSQLiteInMemorySamples(0)
	ranked := run()
	restore()
	if memory != ranked {
		t.Fatalf("in memory\n%s\nranked\n%s", memory, ranked)
	}
	if !strings.Contains(memory, `"error":"divide_by_zero"`) || !strings.Contains(memory, `"summary":null`) {
		t.Fatal("fixture lost its error or empty groups", memory)
	}
}

// percentileAgreementMetrics are the order-statistic metrics of one input.
func percentileAgreementMetrics(id, input string, grouping []string) []qt.AggSpec {
	return []qt.AggSpec{
		{ID: "median_" + id, Expression: "MEDIAN(" + input + ")", GroupBy: grouping},
		{ID: "minmax_" + id, Op: "count", GroupBy: grouping, Distribution: &qt.MetricDistribution{Kind: "box", Input: input}},
		{ID: "tukey_" + id, Op: "count", GroupBy: grouping, Distribution: &qt.MetricDistribution{Kind: "box", Input: input, Whiskers: "tukey"}},
		{ID: "p90_" + id, Expression: "PERCENTILE(" + input + ", 0.9)", GroupBy: grouping},
		{ID: "spread_" + id, Expression: "PERCENTILE(" + input + ", 0.95) - PERCENTILE(" + input + ", 0.05) + MEDIAN(" + input + ")", GroupBy: grouping},
	}
}
