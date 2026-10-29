package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Portable counterpart of the consumer's V2 scalar probe: COUNT plus nine
// SUMs over stored INTEGER NOT NULL columns of a 50,000-row authorship table,
// ungrouped, grouped by day, and grouped with a provider filter that joins
// the conversation table. The source is a host projection like the
// consumer's, flattened by SQLite; the filtered source adds the join.
func scalarMetricsFixture(filtered bool) (string, qt.SQLiteV2Dataset) {
	columns, values, fields := []string{}, []string{}, []string{}
	parts := []string{}
	for i := 0; i < 8; i++ {
		parts = append(parts, fmt.Sprintf("((n+%d)%%7)", i))
	}
	for i := 0; i < 9; i++ {
		columns = append(columns, fmt.Sprintf("n%d INTEGER NOT NULL DEFAULT 0", i))
		value := strings.Join(parts, "+")
		if i > 0 {
			value = parts[i-1]
		}
		values = append(values, value)
		fields = append(fields, fmt.Sprintf("ma.n%d AS n%d", i, i))
	}
	ddl := fmt.Sprintf(`CREATE TABLE conversations(id TEXT PRIMARY KEY, provider TEXT NOT NULL);
INSERT INTO conversations VALUES ('c0','codex'),('c1','claude'),('c2','codex'),('c3','claude'),('c4','codex');
CREATE TABLE authorship(message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, day TEXT NOT NULL, spans_json TEXT NOT NULL, %s);
CREATE INDEX authorship_conversation ON authorship(conversation_id);
WITH RECURSIVE nums(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM nums WHERE n+1<50000)
INSERT INTO authorship SELECT 'm'||n,'c'||(n%%5),printf('2026-09-%%02d',1+n%%5),'[]',%s FROM nums;`, strings.Join(columns, ","), strings.Join(values, ","))
	s := crossFieldSchema()
	delete(s.Fields, "k")
	s.Fields["day"] = qt.FieldSpec{Name: "day", Kind: qt.FieldText, Expr: "r.day", Sortable: true, ServerFilter: true}
	s.Fields["provider"] = qt.FieldSpec{Name: "provider", Kind: qt.FieldEnum, Expr: "r.provider", Sortable: true, ServerFilter: true}
	source := "SELECT ma.message_id AS id,ma.day AS day,NULL AS provider," + strings.Join(fields, ",") + " FROM authorship ma"
	if filtered {
		source = "SELECT ma.message_id AS id,ma.day AS day,c.provider AS provider," + strings.Join(fields, ",") + " FROM authorship ma JOIN conversations c ON c.id=ma.conversation_id"
	}
	return ddl, qt.SQLiteV2Dataset{Schema: s, SourceSQL: source, Scope: "probe", Dataset: "authorship"}
}

func scalarMetricsQuery(grouped, filtered bool) qt.MetricQuery {
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile}
	q.Metrics = append(q.Metrics, qt.AggSpec{ID: "messages", Op: "count"})
	for i := 0; i < 9; i++ {
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("n%d", i), Op: "sum", Field: fmt.Sprintf("n%d", i)})
	}
	if grouped {
		for i := range q.Metrics {
			q.Metrics[i].GroupBy = []string{"day"}
		}
	}
	if filtered {
		q.Where = []qt.WhereTerm{{Field: "provider", Op: "=", Value: "codex"}}
	}
	return q
}

// scalarMetricsSQL returns hand-written comparison statements: bare SQL (one
// GROUP BY with no validation, budgets or error semantics: a cost floor), and
// guarded SQL, which adds the strict per-execution storage and absolute-bound
// proofs the adapter's integer reduction must check for arbitrary input.
func scalarMetricsSQL(grouped, filtered bool, source string) (bare, guarded string) {
	plain, checked, guards := []string{"COUNT(*)"}, []string{"COUNT(*)"}, []string{}
	for i := 0; i < 9; i++ {
		value := fmt.Sprintf("r.n%d", i)
		plain = append(plain, "SUM("+value+")")
		sum := "SUM(CASE WHEN (typeof(" + value + ")='integer' AND " + value + ">=0) OR " + value + " IS NULL THEN " + value + " ELSE 0.0 END)"
		checked = append(checked, sum)
		guards = append(guards, "typeof("+sum+") IN ('integer','null')", "COALESCE("+sum+",0)<=9007199254740991")
	}
	key, by := "", ""
	if grouped {
		key, by = "r.day,", " GROUP BY r.day COLLATE BINARY"
		guards = append(guards, "qt_v2_field_error(r.day,'text') IS NULL")
	}
	where := ""
	if filtered {
		where = " WHERE r.provider='codex'"
	}
	checked = append(checked, "CASE WHEN "+strings.Join(guards, " AND ")+" THEN 1 ELSE 0 END")
	from := " FROM (" + source + ") AS r" + where
	return "SELECT " + key + strings.Join(plain, ",") + from + by, "SELECT " + key + strings.Join(checked, ",") + from + by
}

func BenchmarkV2ScalarMetrics(b *testing.B) {
	for _, shape := range []struct {
		name              string
		grouped, filtered bool
	}{{"scalar", false, false}, {"grouped", true, false}, {"filtered", true, true}} {
		for _, mode := range []string{"adapter", "adapter-proofs", "adapter-proofs-cold", "guarded-sql", "bare-sql"} {
			b.Run(shape.name+"/"+mode, func(b *testing.B) {
				ddl, d := scalarMetricsFixture(shape.filtered)
				if mode != "adapter" && strings.HasPrefix(mode, "adapter") {
					// adapter-proofs keeps one generation: the untimed warmup
					// proves the source and timed executions reuse that proof.
					// adapter-proofs-cold starts a generation for every
					// execution, as if each followed a write: every one proves.
					d.SourceGeneration, d.SourceProofs = "1", &qt.SQLiteSourceProofs{}
				}
				q := scalarMetricsQuery(shape.grouped, shape.filtered)
				bare, guarded := scalarMetricsSQL(shape.grouped, shape.filtered, d.SourceSQL)
				base, err := sql.Open("sqlite", ":memory:")
				if err != nil {
					b.Fatal(err)
				}
				defer base.Close()
				phases := map[string]time.Duration{}
				observe := func(statement string, elapsed time.Duration) {
					phase := "other"
					switch {
					case strings.HasPrefix(statement, "EXPLAIN "):
						phase = "source-proof"
					case strings.HasPrefix(statement, "SELECT COUNT(*) FROM (SELECT 1 FROM"):
						phase = "population"
					case strings.Contains(statement, "qt_integer_input"):
						phase = "reduction"
					case strings.HasPrefix(statement, "SAVEPOINT"), strings.HasPrefix(statement, "RELEASE"), strings.HasPrefix(statement, "ROLLBACK TO"):
						phase = "savepoint"
					case strings.HasPrefix(statement, "DROP TABLE"):
						phase = "cleanup"
					case strings.Contains(statement, "_qt_reduction_"):
						phase = "consumers"
					}
					phases[phase] += elapsed
				}
				// A 64 MiB page cache keeps the fixture in memory, as a host's
				// reader would; uncached page reads otherwise dominate profiles.
				db := sql.OpenDB(phaseConnector{base: base.Driver(), dsn: "file:" + filepath.ToSlash(filepath.Join(b.TempDir(), "scalar.db")) + "?_pragma=cache_size(-65536)", observe: observe})
				db.SetMaxOpenConns(1)
				defer db.Close()
				if _, err = db.Exec(ddl); err != nil {
					b.Fatal(err)
				}
				runs := 0
				run := func() {
					tx, err := db.Begin()
					if err != nil {
						b.Fatal(err)
					}
					defer tx.Rollback()
					switch mode {
					case "adapter", "adapter-proofs", "adapter-proofs-cold":
						if mode == "adapter-proofs-cold" {
							d.SourceGeneration = fmt.Sprint("cold", runs)
						}
						r, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
						if err != nil {
							b.Fatal(err)
						}
						for _, m := range r.Metrics.Metrics {
							if m.Error != "" || len(m.Buckets) == 0 {
								b.Fatal(m.ID, m.Error)
							}
						}
					default:
						statement := bare
						if mode == "guarded-sql" {
							statement = guarded
						}
						rows, err := tx.Query(statement)
						if err != nil {
							b.Fatal(err)
						}
						columns, err := rows.Columns()
						if err != nil {
							b.Fatal(err)
						}
						for rows.Next() {
							values := make([]any, len(columns))
							targets := make([]any, len(columns))
							for i := range values {
								targets[i] = &values[i]
							}
							if err := rows.Scan(targets...); err != nil {
								b.Fatal(err)
							}
							if mode == "guarded-sql" && values[len(values)-1] != int64(1) {
								b.Fatal("synthetic integer fixture failed its proof")
							}
						}
						err = rows.Err()
						rows.Close()
						if err != nil {
							b.Fatal(err)
						}
					}
					if err := tx.Commit(); err != nil {
						b.Fatal(err)
					}
				}
				runBenchmark(b, func() {
					if runs == 1 {
						phases = map[string]time.Duration{}
					}
					runs++
					run()
				})
				b.StopTimer()
				if mode != "guarded-sql" && mode != "bare-sql" {
					for phase, elapsed := range phases {
						b.ReportMetric(float64(elapsed)/float64(b.N), phase+"-ns/op")
					}
				}
			})
		}
	}
}
