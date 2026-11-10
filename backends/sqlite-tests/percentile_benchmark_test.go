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
	db, d := distributionBenchmark(b, 1000000)
	// SQLite has no per-group sample budget unless the host sets one.
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
