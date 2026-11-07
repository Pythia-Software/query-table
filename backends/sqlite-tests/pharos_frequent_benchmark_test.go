package sqlitetests

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Replay the UI's frequent shapes: 50-row tables, indexed row lookups,
// autocomplete keystrokes and a small dashboard-card batch. Optional
// QT_PHAROS_SCHEMA loads the consumer's full schema to include planning cost;
// unrequested bindings are NULL, as Pharos's narrow querySourceSQL makes them.
func BenchmarkPharosFrequent(b *testing.B) {
	for _, name := range []string{"page", "next-page", "recent-page", "lookup", "provider-options", "provider-search", "tool-search", "status-search", "summary-page", "dashboard-cards"} {
		b.Run(name, func(b *testing.B) {
			db := pharosBenchmarkDB(b)
			d := pharosBenchmarkDataset(name == "summary-page")
			if name != "summary-page" {
				if path := os.Getenv("QT_PHAROS_SCHEMA"); path != "" {
					data, err := os.ReadFile(path)
					if err != nil {
						b.Fatal(err)
					}
					schema, err := qt.LoadSQLiteSchema(data)
					if err != nil {
						b.Fatal(err)
					}
					for key, field := range schema.Fields {
						if _, ok := d.Schema.Fields[key]; !ok {
							field.Expr, field.SortExpr, field.SQLiteSortField = "NULL", "NULL", ""
							schema.Fields[key] = field
						}
					}
					d.Schema = schema
				}
				field := d.Schema.Fields["started_at"]
				field.SQLiteDatetimeFormat = "utc-millis"
				d.Schema.Fields["started_at"] = field
			}
			q := pharosBenchmarkRequest()
			q.Rows = true
			q.Result.Select = []string{"id", "provider", "started_at", "duration_ms"}
			q.Result.OrderBy = []qt.OrderBy{{Field: "started_at", Dir: "desc", Nulls: "last"}}
			// Pharos's compact source uses its existing covering page index.
			d.SourceSQL = strings.Replace(d.SourceSQL, "INDEXED BY tool_calls_analytics_idx", "INDEXED BY tool_calls_page_idx", 1)
			switch name {
			case "next-page":
				q.Result.Offset = 50
			case "recent-page", "dashboard-cards":
				d.SourceSQL += " AND t.started_at>=?1"
				d.SourceArgs = []any{"2026-11-01T00:00:00.000Z"}
				q.Result.Where = []qt.WhereTerm{{Field: "started_at", Op: ">=", Value: "2026-11-01T00:00:00Z"}}
				if name == "dashboard-cards" {
					q.Rows = false
					q.Metrics = []qt.AggSpec{{ID: "count", Op: "count"}, {ID: "duration", Op: "sum", Field: "duration_ms"}}
				}
			case "lookup":
				var id string
				if err := db.QueryRow("SELECT id FROM (" + d.SourceSQL + ") ORDER BY started_at DESC,id LIMIT 1").Scan(&id); err != nil {
					b.Fatal(err)
				}
				// Lookup candidates use the primary-key index, as the host does.
				d.SourceSQL = strings.Replace(d.SourceSQL, " INDEXED BY tool_calls_page_idx", "", 1)
				d.SourceSQL += " AND t.id=?1"
				d.SourceArgs = []any{id}
				q.Result.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: id}}
				q.Result.OrderBy, q.Result.Limit = []qt.OrderBy{{Field: "id", Dir: "asc"}}, 1
			case "provider-options", "provider-search", "tool-search", "status-search":
				q.Rows = false
				q.Distinct = &qt.DistinctRequestV3{Field: "provider", Limit: 50}
				if name != "provider-options" {
					q.Distinct.Search = "co"
				}
				if name == "tool-search" || name == "status-search" {
					d.SourceSQL = strings.Replace(d.SourceSQL, "INDEXED BY tool_calls_page_idx", "INDEXED BY tool_calls_analytics_idx", 1)
					q.Distinct.Field, q.Distinct.Search = "tool_name", "read"
					if name == "status-search" {
						q.Distinct.Field, q.Distinct.Search = "status", "e"
					}
				}
			case "summary-page":
				q.Result.Select = []string{"id", "provider", "call_count", "total_duration_ms"}
				q.Result.OrderBy = []qt.OrderBy{{Field: "call_count", Dir: "desc"}}
			}
			var digest [32]byte
			runBenchmark(b, func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer cancel()
				out, err := d.Execute(ctx, db, q, qt.PlanOptions{})
				if err != nil {
					b.Fatal(err)
				}
				for _, metric := range out.Metrics {
					if metric.Error != "" {
						b.Fatal(metric.ID, metric.Error)
					}
				}
				data, err := json.Marshal(out)
				if err != nil {
					b.Fatal(err)
				}
				next := sha256.Sum256(data)
				if digest != [32]byte{} && digest != next {
					b.Fatal("result changed across repetitions")
				}
				digest = next
			})
			b.StopTimer()
			b.Logf("result sha256=%x", digest)
		})
	}
}
