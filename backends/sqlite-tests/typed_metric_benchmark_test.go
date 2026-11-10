package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func typedMetricFixture(rows int) (string, qt.QueryDatasetV3, qt.QueryRequestV3) {
	ddl := fmt.Sprintf(`CREATE TABLE events(id TEXT,g1 TEXT COLLATE NOCASE,g2 TEXT,n INTEGER,m TEXT COLLATE NOCASE);
WITH RECURSIVE nums(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM nums WHERE i<%d)
INSERT INTO events SELECT 'id-'||i,'repo-'||(i%%40),'kind-'||(i%%3),i%%5,'message-'||(i/3) FROM nums;`, rows)
	s := qt.Schema{Name: "events", IDField: "id", Fields: map[string]qt.FieldSpec{}}
	for _, name := range []string{"id", "g1", "g2", "m"} {
		s.Fields[name] = qt.FieldSpec{Name: name, Kind: qt.FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true}
	}
	s.Fields["n"] = qt.FieldSpec{Name: "n", Kind: qt.FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true, ServerFilter: true}
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM events", MaxPopulation: 2000000, MaxStagingBytes: 1 << 30}
	q := metricsV3(nil, nil, 0, 0)
	q.Metrics = []qt.AggSpec{{ID: "rate", Expression: "SUM([n])/NULLIF(COUNT_DISTINCT([m])/1000,0)", GroupBy: []string{"g1", "g2"}, GroupLimit: 200, MinCount: qt.MetricMinCount{Min: 2}}}
	return ddl, d, q
}

// Synthetic counterpart of the reported 1.5M-row metric, including text
// distinctness and two grouping keys. Native SQL is a cost floor: it omits
// typed errors, population counting and executor budgets.
func BenchmarkV3TypedMetric(b *testing.B) {
	for _, mode := range []string{"metric", "grouping", "native"} {
		b.Run(mode, func(b *testing.B) {
			ddl, d, q := typedMetricFixture(1500000)
			db, err := sql.Open("sqlite", filepath.Join(b.TempDir(), "typed.db")+"?_pragma=cache_size(-131072)")
			if err != nil {
				b.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			if _, err = db.Exec(ddl); err != nil {
				b.Fatal(err)
			}
			if mode == "grouping" {
				q.Rows, q.Metrics = true, nil
				q.Grouping = &qt.GroupingDefinition{Keys: []string{"g1", "g2"}, Summaries: []qt.SummaryColumn{{ID: "rate", Op: "formula", Expression: "SUM([n])/NULLIF(COUNT_DISTINCT([m])/1000,0)"}}}
				q.Result = qt.WireQuery{Select: []string{"g1", "g2", "rate"}, Limit: 200}
			}
			runBenchmark(b, func() {
				checkRate := func(key, value any) {
					index, err := strconv.Atoi(strings.TrimPrefix(key.(string), "repo-"))
					if err != nil || value != float64(1000*(index%5)) {
						b.Fatalf("group %v: unexpected rate %v", key, value)
					}
				}
				if mode != "native" {
					out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
					if err != nil {
						b.Fatal(err)
					}
					if mode == "metric" && (len(out.Metrics) != 1 || out.Metrics[0].Error != "" || len(out.Metrics[0].Buckets) != 120) {
						b.Fatal(out.Metrics)
					}
					if mode == "grouping" && len(out.Rows) != 120 {
						b.Fatal(len(out.Rows))
					}
					for _, metric := range out.Metrics {
						for _, bucket := range metric.Buckets {
							if bucket.Error != "" {
								b.Fatal(bucket.Error)
							}
							checkRate(bucket.Keys[0], bucket.Value)
						}
					}
					for _, row := range out.Rows {
						checkRate(row["g1"], row["rate"])
					}
					return
				}
				rows, err := db.Query("SELECT g1,g2,SUM(n)/NULLIF(COUNT(DISTINCT m COLLATE BINARY)/1000.0,0) FROM events GROUP BY g1 COLLATE BINARY,g2 COLLATE BINARY")
				if err != nil {
					b.Fatal(err)
				}
				defer rows.Close()
				count := 0
				for rows.Next() {
					var g1, g2, rate any
					if err := rows.Scan(&g1, &g2, &rate); err != nil {
						b.Fatal(err)
					}
					count++
					checkRate(g1, rate)
				}
				if err := rows.Err(); err != nil {
					b.Fatal(err)
				}
				if count != 120 {
					b.Fatal(count)
				}
			})
		})
	}
}
