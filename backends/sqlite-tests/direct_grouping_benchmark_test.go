package sqlitetests

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// These use the same authorized SQL source, without host indexes or cubes.
// source-copy isolates typed SourcePlan evaluation plus its CTAS write. It
// excludes preflight, validation, grouping and result processing; subtracting it
// from ordinary latency does not predict the performance of a direct plan.
func BenchmarkV3SimpleGrouping(b *testing.B) {
	for _, mode := range []string{"ordinary", "source-copy", "typed-copy", "native"} {
		b.Run(mode, func(b *testing.B) {
			db, err := sql.Open("sqlite", filepath.Join(b.TempDir(), "bench.db"))
			if err != nil {
				b.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			if _, err = db.Exec(crossFieldDDL(50000)); err != nil {
				b.Fatal(err)
			}
			d := qt.QueryDatasetV3{Schema: crossFieldSchema(), SourceSQL: "SELECT * FROM source WHERE tenant=?1", SourceArgs: []any{"allowed"}, Dialect: "sqlite", Scope: "bench", Dataset: "bench"}
			q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC).UnixMilli(), Rows: true,
				Grouping: &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "rows", Op: "count"}, {ID: "values", Op: "count", Field: "n0"}, {ID: "total", Op: "sum", Field: "n0"}, {ID: "average", Op: "avg", Field: "n1"}}},
				Result:   qt.WireQuery{Select: []string{"k", "rows", "values", "total", "average"}, OrderBy: qt.OrderBys{{Field: "k", Dir: "asc"}}, Limit: 100}}
			plan, err := d.SourcePlan(context.Background(), q, qt.PlanOptions{})
			if err != nil {
				b.Fatal(err)
			}
			if mode == "typed-copy" {
				if _, err = db.Exec("CREATE TEMP TABLE normalized AS "+plan.SQL, plan.Args...); err != nil {
					b.Fatal(err)
				}
			}
			runBenchmark(b, func() {
				tx, err := db.Begin()
				if err != nil {
					b.Fatal(err)
				}
				defer tx.Rollback()
				switch mode {
				case "ordinary":
					_, err = d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
				case "typed-copy":
					_, err = tx.Exec("CREATE TEMP TABLE copied_source AS SELECT * FROM normalized")
					if err == nil {
						_, err = tx.Exec("DROP TABLE copied_source")
					}
				case "source-copy":
					_, err = tx.Exec("CREATE TEMP TABLE copied_source AS "+plan.SQL, plan.Args...)
					if err == nil {
						_, err = tx.Exec("DROP TABLE copied_source")
					}
				case "native":
					var rows *sql.Rows
					rows, err = tx.Query("SELECT k,COUNT(*),COUNT(n0),SUM(n0),AVG(n1) FROM source WHERE tenant=?1 GROUP BY k ORDER BY k LIMIT 100", "allowed")
					if err == nil {
						for rows.Next() {
							var k any
							var n, count, sum, avg any
							err = rows.Scan(&k, &n, &count, &sum, &avg)
							if err != nil {
								break
							}
						}
						if err == nil {
							err = rows.Err()
						}
						rows.Close()
					}
				}
				if err != nil {
					b.Fatal(err)
				}
				if err = tx.Commit(); err != nil {
					b.Fatal(err)
				}
			})
			b.StopTimer()
			var pages, pageSize int64
			if err := db.QueryRow("PRAGMA temp.page_count").Scan(&pages); err != nil {
				b.Fatal(err)
			}
			if err := db.QueryRow("PRAGMA temp.page_size").Scan(&pageSize); err != nil {
				b.Fatal(err)
			}
			b.ReportMetric(float64(pages*pageSize), "temp-bytes-highwater")
		})
	}
}
