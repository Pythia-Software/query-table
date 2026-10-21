package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Portable QT-14 comparison: 50,000 authorized rows, nine integer columns,
// COUNT plus nine SUM cards. Native SQL is a cost floor for this safe fixture;
// it does not implement the adapter's validation, budgets or error semantics.
func BenchmarkCrossFieldV2(b *testing.B) {
	for _, grouped := range []bool{false, true} {
		for _, mode := range []string{"independent", "batch", "guarded-sql", "native"} {
			b.Run(fmt.Sprintf("grouped=%t/%s", grouped, mode), func(b *testing.B) {
				db, err := sql.Open("sqlite", filepath.Join(b.TempDir(), "bench.db"))
				if err != nil {
					b.Fatal(err)
				}
				defer db.Close()
				db.SetMaxOpenConns(1)
				if _, err = db.Exec(crossFieldDDL(50000)); err != nil {
					b.Fatal(err)
				}
				d := qt.SQLiteV2Dataset{Schema: crossFieldSchema(), SourceSQL: "SELECT * FROM source WHERE tenant=?1", SourceArgs: []any{"allowed"}}
				q := crossFieldQuery(grouped)
				columns := []string{"COUNT(*)"}
				checkedColumns := []string{"COUNT(*)"}
				checks := []string{}
				for i := 0; i < 9; i++ {
					columns = append(columns, fmt.Sprintf("SUM(n%d)", i))
					value := fmt.Sprintf("n%d", i)
					sum := "SUM(CASE WHEN (typeof(" + value + ")='integer' AND " + value + ">=0) OR " + value + " IS NULL THEN " + value + " ELSE 0.0 END)"
					checkedColumns = append(checkedColumns, sum)
					checks = append(checks, "typeof("+sum+") IN ('integer','null')", "COALESCE("+sum+",0)<=9007199254740991")
				}
				native := "SELECT " + strings.Join(columns, ",") + " FROM source WHERE tenant=?1"
				if grouped {
					native += " GROUP BY k"
					checks = append(checks, "qt_v2_field_error(k,'text') IS NULL")
				}
				// Isolate storage/bounds proof cost from compiler, population
				// preflight, savepoints, result mapping and scratch-table lifecycle.
				// This is a benchmark ablation, not an adapter implementation.
				checkedColumns = append(checkedColumns, "CASE WHEN "+strings.Join(checks, " AND ")+" THEN 1 ELSE 0 END")
				checked := "SELECT " + strings.Join(checkedColumns, ",") + " FROM source WHERE tenant=?1"
				if grouped {
					checked += " GROUP BY k COLLATE BINARY"
				}
				runBenchmark(b, func() {
					tx, err := db.Begin()
					if err != nil {
						b.Fatal(err)
					}
					defer tx.Rollback()
					switch mode {
					case "native", "guarded-sql":
						statement := native
						if mode == "guarded-sql" {
							statement = checked
						}
						rows, err := tx.Query(statement, "allowed")
						if err != nil {
							b.Fatal(err)
						}
						outputColumns, err := rows.Columns()
						if err != nil {
							rows.Close()
							b.Fatal(err)
						}
						for rows.Next() {
							v := make([]any, len(outputColumns))
							ptr := make([]any, len(outputColumns))
							for i := range v {
								ptr[i] = &v[i]
							}
							if err := rows.Scan(ptr...); err != nil {
								b.Fatal(err)
							}
							if mode == "guarded-sql" && v[len(v)-1] != int64(1) {
								b.Fatal("synthetic integer fixture failed its proof")
							}
						}
						err = rows.Err()
						rows.Close()
						if err != nil {
							b.Fatal(err)
						}
					default:
						requests := []qt.MetricQuery{q}
						if mode == "independent" {
							requests = nil
							for _, spec := range q.Metrics {
								single := q
								single.Metrics = []qt.AggSpec{spec}
								requests = append(requests, single)
							}
						}
						for _, request := range requests {
							r, err := d.ExecuteV2In(context.Background(), tx, nil, &request, qt.PlanOptions{})
							if err != nil {
								b.Fatal(err)
							}
							for _, m := range r.Metrics.Metrics {
								if m.Error != "" {
									b.Fatal(m.Error)
								}
							}
						}
					}
					if err := tx.Commit(); err != nil {
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
}
