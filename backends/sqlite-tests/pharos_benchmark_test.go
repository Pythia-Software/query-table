package sqlitetests

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Opt in with QT_PHAROS_CATALOG=<isolated library>/catalog/catalog.sqlite3.
// Never initialize/migrate this database or print its records. The Pharos
// tools/dev.py marker is required; main is opened read-only, TEMP is writable.
// Sources reproduce the host's narrow, covering projections and mirrored-work
// exclusion. No host native reducer, generation cache or analytics cube runs.
func pharosBenchmarkDB(b *testing.B) *sql.DB {
	b.Helper()
	path := os.Getenv("QT_PHAROS_CATALOG")
	if path == "" {
		b.Skip("set QT_PHAROS_CATALOG to an isolated Pharos dev snapshot")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		b.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(filepath.Dir(filepath.Dir(path)), ".pharos-dev")); err != nil {
		b.Fatal("expected an isolated tools/dev.py snapshot: ", err)
	}
	u := url.URL{Scheme: "file", Path: path}
	u.RawQuery = "mode=ro&_pragma=cache_size(-32768)&_pragma=mmap_size(268435456)&_pragma=temp_store(FILE)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		b.Fatal(err)
	}
	if os.Getenv("QT_PHAROS_PHASES") != "" {
		phases := map[string]time.Duration{}
		base := db
		db = sql.OpenDB(phaseConnector{base: base.Driver(), dsn: u.String(), observe: func(statement string, elapsed time.Duration) {
			phase := "other"
			switch {
			case strings.Contains(statement, "qt_source_budget"):
				phase = "source-preflight"
			case strings.Contains(statement, "qt_rank"):
				phase = "representative"
			case strings.Contains(statement, "qt_groups"):
				phase = "group-reduction"
			case strings.Contains(statement, "qt_integer_input"):
				phase = "integer-reduction"
			case strings.HasPrefix(statement, "CREATE TEMP TABLE"), strings.HasPrefix(statement, "INSERT INTO"):
				phase = "source-stage"
			case strings.HasPrefix(statement, "UPDATE"), strings.HasPrefix(statement, "WITH qt_calendar_keys"):
				phase = "key-and-summary-updates"
			case strings.HasPrefix(statement, "DROP TABLE"):
				phase = "cleanup"
			}
			phases[phase] += elapsed
		}})
		base.Close()
		b.Cleanup(func() {
			names := []string{}
			for name := range phases {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				b.Logf("phase total including warmup %s: %s", name, phases[name])
			}
		})
	}
	db.SetMaxOpenConns(1)
	b.Cleanup(func() { db.Close() })
	return db
}

func pharosBenchmarkDataset(summary bool) qt.QueryDatasetV3 {
	yes := true
	s := qt.Schema{Name: "pharos_tool_calls", IDField: "id", Fields: map[string]qt.FieldSpec{}}
	for _, name := range []string{"id", "provider", "tool_name", "status", "started_at", "duration_ms", "result_tokens", "carried_tokens", "output_tokens", "call_count", "total_duration_ms"} {
		kind := qt.FieldText
		switch name {
		case "duration_ms", "result_tokens", "carried_tokens", "output_tokens", "call_count", "total_duration_ms":
			kind = qt.FieldNumber
		case "started_at":
			kind = qt.FieldDatetime
		}
		s.Fields[name] = qt.FieldSpec{Name: name, Kind: kind, Expr: "r." + name, ServerFilter: true, Sortable: true, ExpressionNumeric: true, Groupable: &yes}
	}
	f := s.Fields["started_at"]
	f.SQLiteDatetimeFormat = "rfc3339"
	s.Fields["started_at"] = f
	source := `SELECT t.id,t.provider,t.tool_name,t.status,t.started_at,t.duration_ms,t.result_tokens,t.carried_tokens,t.output_tokens,NULL AS call_count,NULL AS total_duration_ms
FROM tool_calls t INDEXED BY tool_calls_analytics_idx
WHERE t.workspace_id NOT IN (SELECT workspace_id FROM tool_mirror_workspaces)`
	if summary {
		s.Name = "pharos_tools"
		source = `SELECT id,provider,tool_name,call_count,total_duration_ms,result_tokens,carried_tokens,output_tokens,NULL AS status,NULL AS started_at,NULL AS duration_ms FROM tool_usage_daily`
	}
	return qt.QueryDatasetV3{Schema: s, SourceSQL: source, Dialect: "sqlite", MaxPopulation: 10000000, MaxGroups: 100000, MaxStagingBytes: 512 << 20}
}

func pharosBenchmarkRequest() qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC).UnixMilli(), Result: qt.WireQuery{Limit: 50}}
}

func BenchmarkPharosSQLite(b *testing.B) {
	for _, name := range []string{"count", "scalar", "metric-group", "formula-batch", "groups", "group-formula", "multi-groups", "calendar", "representative", "summary-groups", "summary-fractions"} {
		b.Run(name, func(b *testing.B) {
			db := pharosBenchmarkDB(b)
			d := pharosBenchmarkDataset(strings.HasPrefix(name, "summary-"))
			q := pharosBenchmarkRequest()
			switch name {
			case "count":
				q.Metrics = []qt.AggSpec{{ID: "count", Op: "count"}}
			case "scalar", "metric-group":
				q.Metrics = []qt.AggSpec{{ID: "duration", Op: "sum", Field: "duration_ms"}}
				if name == "metric-group" {
					q.Metrics[0].GroupBy = []string{"provider"}
				}
			case "formula-batch":
				for i := range 20 {
					q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprint("m", i), Expression: fmt.Sprintf("SUM([duration_ms])+%d", i), GroupBy: []string{"provider"}})
				}
			default:
				field := "duration_ms"
				if strings.HasPrefix(name, "summary-") {
					field = "total_duration_ms"
				}
				if name == "summary-fractions" {
					field = "output_tokens"
				}
				q.Rows = true
				q.Grouping = &qt.GroupingDefinition{Keys: []string{"provider"}, Summaries: []qt.SummaryColumn{{ID: "records", Op: "count"}, {ID: "amount", Op: "sum", Field: field}}}
				q.Result.Select = []string{"provider", "records", "amount"}
				q.Result.OrderBy = []qt.OrderBy{{Field: "records", Dir: "desc"}}
				if name == "group-formula" {
					q.Grouping.Summaries[1] = qt.SummaryColumn{ID: "amount", Op: "formula", Expression: "SUM([duration_ms])/NULLIF(COUNT(),0)"}
				}
				if name == "multi-groups" {
					q.Grouping.Keys = append(q.Grouping.Keys, "tool_name", "status")
					q.Result.Select = append(q.Result.Select, "tool_name", "status")
				}
				if name == "calendar" {
					q.Grouping.Keys = []string{"started_at"}
					q.Grouping.KeyIntervals = map[string]qt.GroupKeyInterval{"started_at": {Interval: "month", TimeZone: "America/Denver"}}
					q.Result.Select[0] = "started_at"
				}
				if name == "representative" {
					q.Grouping.Summaries = append(q.Grouping.Summaries, qt.SummaryColumn{ID: "example", Op: "row", Field: "id"})
					q.Grouping.Representative = &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "duration_ms", Dir: "desc", Nulls: "last"}}}
					q.Result.Select = append(q.Result.Select, "example")
				}
			}
			var digest [32]byte
			var population, groups int64
			run := func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer cancel()
				out, err := d.Execute(ctx, db, q, qt.PlanOptions{})
				if err != nil {
					b.Fatal(err)
				}
				for _, m := range out.Metrics {
					if m.Error != "" {
						b.Fatalf("metric %s: %s", m.ID, m.Error)
					}
				}
				population, groups = out.SourceTotal, out.Total
				// Ignore plan metadata; include rows, exact values and diagnostics.
				payload, err := json.Marshal([]any{out.Rows, out.Metrics, out.SourceTotal, out.Total})
				if err != nil {
					b.Fatal(err)
				}
				next := sha256.Sum256(payload)
				if digest != [32]byte{} && digest != next {
					b.Fatal("result changed across repetitions")
				}
				digest = next
			}
			runBenchmark(b, run)
			b.StopTimer()
			b.ReportMetric(float64(population), "source-rows")
			b.ReportMetric(float64(groups), "result-rows")
			b.Logf("result sha256=%x", digest)
		})
	}
}

// Bare SQL is a cost floor, not an equivalent executor: it omits storage,
// arithmetic, budget, identity, revision and response-envelope checks.
func BenchmarkPharosSQLiteNative(b *testing.B) {
	for _, shape := range []struct{ name, selectSQL, by string }{
		{"count", "COUNT(*)", ""},
		{"scalar", "COUNT(*),SUM(duration_ms)", ""},
		{"groups", "provider,COUNT(*),SUM(duration_ms)", " GROUP BY provider COLLATE BINARY"},
		{"multi-groups", "provider,tool_name,status,COUNT(*),SUM(duration_ms)", " GROUP BY provider COLLATE BINARY,tool_name COLLATE BINARY,status COLLATE BINARY"},
	} {
		b.Run(shape.name, func(b *testing.B) {
			db := pharosBenchmarkDB(b)
			statement := "SELECT " + shape.selectSQL + " FROM (" + pharosBenchmarkDataset(false).SourceSQL + ") AS r" + shape.by
			runBenchmark(b, func() {
				rows, err := db.Query(statement)
				if err != nil {
					b.Fatal(err)
				}
				defer rows.Close()
				columns, err := rows.Columns()
				if err != nil {
					b.Fatal(err)
				}
				values, dest := make([]any, len(columns)), make([]any, len(columns))
				for i := range values {
					dest[i] = &values[i]
				}
				for rows.Next() {
					if err := rows.Scan(dest...); err != nil {
						b.Fatal(err)
					}
				}
				if err := rows.Err(); err != nil {
					b.Fatal(err)
				}
			})
		})
	}
}
