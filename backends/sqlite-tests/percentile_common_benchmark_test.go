package sqlitetests

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// commonPercentileTable stages groups×size timing rows (about 1% NULL
// samples), group g<i%groups>, with the host's default dataset budgets.
func commonPercentileTable(b *testing.B, groups, size int) (*sql.DB, qt.QueryDatasetV3) {
	b.Helper()
	rows := groups * size
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(b.TempDir(), "common.db"))+"?_pragma=cache_size(-32768)")
	if err != nil {
		b.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	b.Cleanup(func() { db.Close() })
	if _, err = db.Exec(fmt.Sprintf(`CREATE TABLE common(id INTEGER PRIMARY KEY,g TEXT,latency REAL);
WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
INSERT INTO common SELECT i,'g'||(i%%%d),CASE WHEN i%%97=0 THEN NULL ELSE ((i*7919)%%100000)/10.0+((i*31)%%7)*((i*31)%%7)*250 END FROM nums;`, rows, groups)); err != nil {
		b.Fatal(err)
	}
	schema := qt.Schema{Name: "common", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":      {Name: "id", Kind: qt.FieldNumber, Expr: "r.id", ExpressionNumeric: true, Sortable: true},
		"g":       {Name: "g", Kind: qt.FieldText, Expr: "r.g", Sortable: true, ServerFilter: true},
		"latency": {Name: "latency", Kind: qt.FieldNumber, Expr: "r.latency", ExpressionNumeric: true, Sortable: true},
	}}
	return db, qt.QueryDatasetV3{Dialect: "sqlite", Schema: schema, SourceSQL: "SELECT * FROM common", MaxPopulation: rows}
}

// Groups well under 100,000 samples, as host cards use today: MEDIAN, min/max
// and Tukey boxes, through the default executor and the staged one.
//
//	go test -run '^$' -bench CommonPercentiles -benchtime 3x
func BenchmarkCommonPercentiles(b *testing.B) {
	for _, shape := range []struct {
		name         string
		groups, size int
	}{{"8x10k", 8, 10000}, {"50x2k", 50, 2000}, {"1x90k", 1, 90000}} {
		db, d := commonPercentileTable(b, shape.groups, shape.size)
		groupBy := []string{"g"}
		if shape.groups == 1 {
			groupBy = nil
		}
		for _, metric := range []qt.AggSpec{
			{ID: "median", Expression: "MEDIAN([latency])", GroupBy: groupBy},
			{ID: "box", Op: "count", GroupBy: groupBy, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency]"}},
			{ID: "tukey", Op: "count", GroupBy: groupBy, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[latency]", Whiskers: "tukey"}},
		} {
			for _, executor := range []string{"default", "staged"} {
				dataset := d
				if executor == "staged" {
					dataset = qt.TestOnlyStageUngrouped(d)
				}
				q := metricsV3(nil, nil, 0, 0, metric)
				b.Run(shape.name+"/"+metric.ID+"/"+executor, func(b *testing.B) {
					runBenchmark(b, func() {
						r, err := dataset.Execute(b.Context(), db, q, qt.PlanOptions{})
						if err != nil {
							b.Fatal(err)
						}
						if m := r.Metrics[0]; m.Error != "" || len(m.Buckets) == 0 || m.Buckets[0].Error != "" {
							b.Fatal(mustJSON(b, m))
						}
					})
				})
			}
		}
	}
}
