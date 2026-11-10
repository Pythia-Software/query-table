package sqlitetests

import (
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// One ungrouped population of 1,000,000 timing rows (about 1% NULL samples).
// Run with, for example:
//
//	go test -run '^$' -bench 'Percentile' -count 3
func runPercentileBenchmark(b *testing.B, metric qt.AggSpec, options ...func(qt.QueryDatasetV3) qt.QueryDatasetV3) {
	runPercentileRowsBenchmark(b, 1000000, metric, options...)
}

func runPercentileRowsBenchmark(b *testing.B, rows int, metric qt.AggSpec, options ...func(qt.QueryDatasetV3) qt.QueryDatasetV3) {
	db, d := distributionBenchmark(b, rows)
	// SQLite's default per-group sample budget.
	d.MaxSamplesPerGroup = 0
	for _, option := range options {
		d = option(d)
	}
	q := metricsV3(nil, nil, 0, 0, metric)
	runBenchmark(b, func() {
		r, err := d.Execute(b.Context(), db, q, qt.PlanOptions{})
		if err != nil {
			b.Fatal(err)
		}
		for _, m := range r.Metrics {
			if m.Error != "" {
				b.Fatal(m.ID, m.Error)
			}
			for _, bucket := range m.Buckets {
				if bucket.Error != "" {
					b.Fatal(m.ID, bucket.Error)
				}
			}
		}
	})
}

// stagedPercentiles compiles the metric over the staged population, as
// grouped requests do; the direct in-memory distribution scan does not apply.
func stagedPercentiles(d qt.QueryDatasetV3) qt.QueryDatasetV3 { return qt.TestOnlyStageUngrouped(d) }

// 1,000,000 rows: MEDIAN of one group.
func BenchmarkPercentileMedianMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "median", Expression: "MEDIAN([latency_ms])"})
}

// 1,000,000 rows: MEDIAN by effort (eight groups).
func BenchmarkPercentileGroupedMedianMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "median", Expression: "MEDIAN([latency_ms])", GroupBy: []string{"effort"}})
}

// 1,000,000 rows: a min/max box of one group.
func BenchmarkPercentileBoxMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]"}})
}

// 1,000,000 rows: a Tukey box of one group.
func BenchmarkPercentileTukeyMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]", Whiskers: "tukey"}})
}

// 1,000,000 rows: a min/max box of one group over the staged population.
func BenchmarkPercentileStagedBoxMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]"}}, stagedPercentiles)
}

// 1,000,000 rows: a Tukey box of one group over the staged population.
func BenchmarkPercentileStagedTukeyMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]", Whiskers: "tukey"}}, stagedPercentiles)
}

// rankedPercentiles empties the in-memory sample budget for the benchmark,
// so every group is ranked in SQL.
func rankedPercentiles(b *testing.B) func(qt.QueryDatasetV3) qt.QueryDatasetV3 {
	b.Cleanup(qt.TestOnlySetSQLiteInMemorySamples(0))
	return func(d qt.QueryDatasetV3) qt.QueryDatasetV3 { return d }
}

// 2,000,000 rows: MEDIAN of one group, sorted in memory.
func BenchmarkPercentileMedianTwoMillion(b *testing.B) {
	runPercentileRowsBenchmark(b, 2000000, qt.AggSpec{ID: "median", Expression: "MEDIAN([latency_ms])"})
}

// 2,000,000 rows: MEDIAN of one group, ranked in SQL.
func BenchmarkPercentileRankedMedianTwoMillion(b *testing.B) {
	runPercentileRowsBenchmark(b, 2000000, qt.AggSpec{ID: "median", Expression: "MEDIAN([latency_ms])"}, rankedPercentiles(b))
}

// 2,000,000 rows: a Tukey box of one group over the staged population.
func BenchmarkPercentileStagedTukeyTwoMillion(b *testing.B) {
	runPercentileRowsBenchmark(b, 2000000, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]", Whiskers: "tukey"}}, stagedPercentiles)
}

// 1,000,000 rows: MEDIAN of one group, ranked in SQL.
func BenchmarkPercentileRankedMedianMillion(b *testing.B) {
	runPercentileBenchmark(b, qt.AggSpec{ID: "median", Expression: "MEDIAN([latency_ms])"}, rankedPercentiles(b))
}
