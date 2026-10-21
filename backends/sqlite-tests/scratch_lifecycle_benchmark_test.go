package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Reused connection, 578 schema objects, file-backed scratch with a small temp
// cache. Includes the host's commit/rollback and the next catalog read. The SQL
// driver has no public sqlite3_stmt_status(REPREPARE) counter: followup-ns/op
// measures latency, and is not a count of schema reloads or disk writes.
func BenchmarkSQLiteScratchLifecycle(b *testing.B) {
	for _, mode := range []string{"commit", "rollback", "cancel"} {
		b.Run(mode, func(b *testing.B) {
			base, err := sql.Open("sqlite", ":memory:")
			if err != nil {
				b.Fatal(err)
			}
			defer base.Close()
			var cancel context.CancelFunc
			creates := 0
			hook := func(query string) error {
				if strings.HasPrefix(query, "CREATE TEMP TABLE") {
					creates++
					if mode == "cancel" && creates == 2 && cancel != nil {
						cancel()
					}
				}
				return nil
			}
			db := sql.OpenDB(statementHookConnector{base: base.Driver(), dsn: filepath.Join(b.TempDir(), "catalog.db"), hook: hook})
			defer db.Close()
			db.SetMaxOpenConns(1)
			if _, err = db.Exec(crossFieldDDL(20000)); err != nil {
				b.Fatal(err)
			}
			if err = syntheticCatalog(db, 578); err != nil {
				b.Fatal(err)
			}
			conn, err := db.Conn(context.Background())
			if err != nil {
				b.Fatal(err)
			}
			defer conn.Close()
			if _, err = conn.ExecContext(context.Background(), "PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-32"); err != nil {
				b.Fatal(err)
			}
			d := qt.QueryDatasetV3{Schema: crossFieldSchema(), SourceSQL: "SELECT * FROM source WHERE tenant=?1", SourceArgs: []any{"allowed"}, Dialect: "sqlite"}
			q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC).UnixMilli(), Rows: true, Grouping: &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n0"}}}, Result: qt.WireQuery{Select: []string{"k", "num", "total"}, Limit: 100}}
			followup := time.Duration(0)
			runs := 0
			runBenchmark(b, func() {
				creates = 0
				tx, err := conn.BeginTx(context.Background(), nil)
				if err != nil {
					b.Fatal(err)
				}
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				_, err = d.ExecuteIn(ctx, tx, q, qt.PlanOptions{})
				stop()
				cancel = nil
				if mode == "cancel" {
					if !errors.Is(err, context.Canceled) {
						b.Fatalf("cancel: %v", err)
					}
				} else if err != nil {
					b.Fatal(err)
				}
				if mode == "commit" {
					err = tx.Commit()
				} else {
					err = tx.Rollback()
				}
				if err != nil && !errors.Is(err, sql.ErrTxDone) {
					b.Fatal(err)
				}
				start := time.Now()
				var n int
				if err = conn.QueryRowContext(context.Background(), "SELECT n FROM catalog_577").Scan(&n); err != nil || n != 577 {
					b.Fatal(n, err)
				}
				elapsed := time.Since(start)
				if runs > 0 {
					followup += elapsed
				}
				runs++
			})
			// The first run is the untimed warmup.
			b.ReportMetric(float64(followup)/float64(b.N), "followup-ns/op")
			b.StopTimer()
			var pages, pageSize int64
			if err = conn.QueryRowContext(context.Background(), "PRAGMA temp.page_count").Scan(&pages); err != nil {
				b.Fatal(err)
			}
			if err = conn.QueryRowContext(context.Background(), "PRAGMA temp.page_size").Scan(&pageSize); err != nil {
				b.Fatal(err)
			}
			b.ReportMetric(float64(pages*pageSize), "temp-bytes-highwater")
			var objects int
			if err = conn.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM sqlite_temp_master WHERE name LIKE 'qt_v3_%'").Scan(&objects); err != nil || objects != 0 {
				b.Fatal(fmt.Sprintf("scratch objects=%d: %v", objects, err))
			}
		})
	}
}
