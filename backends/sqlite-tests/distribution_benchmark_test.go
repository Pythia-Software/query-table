package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// distributionBenchmark builds a narrow, indexed timing table like a host's
// request log: rows records over eight efforts (one NULL) with skewed latencies, token
// counts and some NULL samples. Run with, for example:
//
//	go test -run '^$' -bench Distribution -count 3
func distributionBenchmark(tb testing.TB, rows int) (*sql.DB, qt.QueryDatasetV3) {
	tb.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(tb.TempDir(), "timing.db"))+"?_pragma=cache_size(-32768)")
	if err != nil {
		tb.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	tb.Cleanup(func() { db.Close() })
	_, err = db.Exec(fmt.Sprintf(`CREATE TABLE timing(id INTEGER PRIMARY KEY,effort TEXT,started TEXT,latency_ms REAL,output_tokens INTEGER);
WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
INSERT INTO timing SELECT i,CASE WHEN i%%8=7 THEN NULL ELSE 'effort '||(i%%8) END,
 strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ',1767225600+i*10,'unixepoch'),
 CASE WHEN i%%97=0 THEN NULL ELSE ((i*7919)%%100000)/10.0+((i*31)%%7)*((i*31)%%7)*250 END,
 CASE WHEN i%%53=0 THEN NULL ELSE (i*104729)%%20000 END FROM nums;
CREATE INDEX timing_started ON timing(started);`, rows))
	if err != nil {
		tb.Fatal(err)
	}
	schema := qt.Schema{Name: "timing", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":            {Name: "id", Kind: qt.FieldNumber, Expr: "r.id", ExpressionNumeric: true, Sortable: true}, // v3 orders by and validates the numeric identity
		"effort":        {Name: "effort", Kind: qt.FieldEnum, Expr: "r.effort", Sortable: true, ServerFilter: true},
		"started":       {Name: "started", Kind: qt.FieldDatetime, Expr: "r.started", SQLiteDatetimeFormat: "rfc3339", Sortable: true, ServerFilter: true},
		"latency_ms":    {Name: "latency_ms", Kind: qt.FieldNumber, Expr: "r.latency_ms", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"output_tokens": {Name: "output_tokens", Kind: qt.FieldNumber, Expr: "r.output_tokens", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
	}}
	// SQLite histograms count against MaxSamplesPerGroup; allow the whole table.
	return db, qt.QueryDatasetV3{Dialect: "sqlite", Schema: schema, SourceSQL: "SELECT * FROM timing", MaxPopulation: rows, MaxSamplesPerGroup: 1000000}
}

func distributionMetrics() []qt.AggSpec {
	return []qt.AggSpec{
		{ID: "latency", GroupBy: []string{"effort"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]"}},
		{ID: "latency_tukey", GroupBy: []string{"effort"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency_ms]", Whiskers: "tukey"}},
		{ID: "tokens", GroupBy: []string{"effort"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[output_tokens]"}},
		{ID: "latency_histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[latency_ms]", Bins: 20}},
		{ID: "rate", GroupBy: []string{"effort"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[output_tokens]*1000/[latency_ms]"}},
	}
}

func runDistributionBenchmark(b *testing.B, metrics []qt.AggSpec) {
	db, d := distributionBenchmark(b, 600000)
	q := metricsV3(nil, nil, 0, 0, metrics...)
	runBenchmark(b, func() {
		r, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
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

// 600,000 rows: one box metric grouped by a low-cardinality enum.
func BenchmarkDistributionBox(b *testing.B) {
	runDistributionBenchmark(b, distributionMetrics()[:1])
}

// 600,000 rows: one histogram over the whole population.
func BenchmarkDistributionHistogram(b *testing.B) {
	runDistributionBenchmark(b, distributionMetrics()[3:4])
}

// 600,000 rows: four field distributions, which share one population scan.
func BenchmarkDistributionFields(b *testing.B) {
	runDistributionBenchmark(b, distributionMetrics()[:4])
}

// 600,000 rows: five box and histogram metrics in one request.
func BenchmarkDistributionBatch(b *testing.B) {
	runDistributionBenchmark(b, distributionMetrics())
}

// 600,000 rows: a grouped histogram of a formula, which needs compiled SQL.
func BenchmarkDistributionFormula(b *testing.B) {
	runDistributionBenchmark(b, distributionMetrics()[4:5])
}
