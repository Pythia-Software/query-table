package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Exact portable counterpart of the 2026-10-21 consumer fixture, including
// authorization, provider filtering, ignored source paging and both scopes.
func usageGroupsFixture() (string, qt.QueryDatasetV3, qt.QueryRequestV3) {
	s := crossFieldSchema()
	delete(s.Fields, "k")
	s.Fields["day"] = qt.FieldSpec{Name: "day", Kind: qt.FieldText, Expr: "r.day", Sortable: true, ServerFilter: true}
	s.Fields["provider"] = qt.FieldSpec{Name: "provider", Kind: qt.FieldEnum, Expr: "r.provider", Sortable: true, ServerFilter: true}
	columns, values := []string{}, []string{}
	total := []string{}
	for i := 0; i < 8; i++ {
		total = append(total, fmt.Sprintf("(n+%d)%%7", i))
	}
	for i := 0; i < 9; i++ {
		columns = append(columns, fmt.Sprintf("n%d", i))
		value := strings.Join(total, "+")
		if i > 0 {
			value = fmt.Sprintf("(n+%d)%%7", i-1)
		}
		values = append(values, value)
	}
	ddl := fmt.Sprintf(`CREATE TABLE usage(id TEXT,day TEXT,provider TEXT,tenant TEXT,%s);
WITH RECURSIVE nums(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM nums WHERE n<49999)
INSERT INTO usage SELECT printf('%%08d',n),'2026-09-0'||(n%%5+1),CASE WHEN n%%5 IN (0,2,4) THEN 'codex' ELSE 'claude' END,'allowed',%s FROM nums;
INSERT INTO usage SELECT 'hidden','hidden','codex','denied',%s;
CREATE INDEX usage_provider ON usage(tenant,provider);`, strings.Join(columns, ","), strings.Join(values, ","), strings.Repeat("999,", 8)+"999")
	d := qt.QueryDatasetV3{Schema: s, SourceSQL: "SELECT * FROM usage WHERE tenant=?1", SourceArgs: []any{"allowed"}, Dialect: "sqlite"}
	q := groupedRequest()
	q.Source = qt.WireQuery{Limit: 1, Offset: 100}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"day"}, Summaries: []qt.SummaryColumn{{ID: "messages", Op: "count"}, {ID: "words_total", Op: "sum", Field: "n0"}, {ID: "mean", Op: "avg", Field: "n0"}}}
	q.Result = qt.WireQuery{Select: []string{"day", "messages", "words_total", "mean"}, OrderBy: qt.OrderBys{{Field: "day", Dir: "asc"}}, Limit: 2}
	q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}, {ID: "shown_messages", Op: "sum", Field: "messages", Scope: "shownRows"}}
	return ddl, d, q
}

func TestV3UsageGroups(t *testing.T) {
	ddl, d, q := usageGroupsFixture()
	log := &statementLog{}
	db := hookedDB(t, log, ddl)
	got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || got.SourceTotal != 50000 || got.Total != 5 || len(got.Rows) != 2 || got.Metrics[1].Buckets[0].Value != float64(20000) {
		t.Fatalf("%#v / %v", got, err)
	}
	if log.count("qt_integer_input") == 0 {
		t.Fatal("ordinary request did not use direct reduction")
	}
	q.Source.Where = []qt.WhereTerm{{Field: "provider", Op: "=", Value: "codex"}}
	got, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || got.SourceTotal != 30000 || got.Total != 3 || got.Metrics[1].Buckets[0].Value != float64(20000) {
		t.Fatalf("%#v / %v", got, err)
	}
}

// SQL time by statement category. This includes QueryContext, row stepping and
// close, and excludes compilation/Go mapping. The direct statement fuses source
// proofs, bytes and grouping; its components cannot be timed independently.
type phaseConnector struct {
	base    driver.Driver
	dsn     string
	observe func(string, time.Duration)
	decline bool
}

func (c phaseConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return phaseConn{Conn: conn, ConnBeginTx: conn.(driver.ConnBeginTx), parent: c}, nil
}

func (c phaseConnector) Driver() driver.Driver { return c.base }

type phaseConn struct {
	driver.Conn
	driver.ConnBeginTx
	parent phaseConnector
}

func (c phaseConn) ExecContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Result, error) {
	start := time.Now()
	defer func() { c.parent.observe(q, time.Since(start)) }()
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, a)
}
func (c phaseConn) QueryContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Rows, error) {
	if c.parent.decline {
		if err := declineDirect(q); err != nil {
			return nil, err
		}
	}
	start := time.Now()
	rows, err := c.Conn.(driver.QueryerContext).QueryContext(ctx, q, a)
	c.parent.observe(q, time.Since(start))
	if err != nil {
		return nil, err
	}
	return phaseRows{Rows: rows, q: q, observe: c.parent.observe}, nil
}

type phaseRows struct {
	driver.Rows
	q       string
	observe func(string, time.Duration)
}

func (r phaseRows) Next(v []driver.Value) error {
	start := time.Now()
	defer func() { r.observe(r.q, time.Since(start)) }()
	return r.Rows.Next(v)
}
func (r phaseRows) Close() error {
	start := time.Now()
	defer func() { r.observe(r.q, time.Since(start)) }()
	return r.Rows.Close()
}

func BenchmarkV3UsageGroups(b *testing.B) {
	for _, filtered := range []bool{false, true} {
		for _, mode := range []string{"ordinary", "general", "native"} {
			b.Run(fmt.Sprintf("filtered=%t/%s", filtered, mode), func(b *testing.B) {
				ddl, d, q := usageGroupsFixture()
				if filtered {
					q.Source.Where = []qt.WhereTerm{{Field: "provider", Op: "=", Value: "codex"}}
				}
				base, err := sql.Open("sqlite", ":memory:")
				if err != nil {
					b.Fatal(err)
				}
				defer base.Close()
				phases := map[string]time.Duration{}
				metric := false
				observe := func(statement string, elapsed time.Duration) {
					phase := "result"
					switch {
					case strings.HasPrefix(statement, "DROP TABLE"):
						phase = "cleanup"
					case strings.HasPrefix(statement, "EXPLAIN "):
						phase = "source-proof"
					case strings.HasPrefix(statement, "CREATE TEMP TABLE") && strings.Contains(statement, "qt_integer_input"):
						phase = "proof-and-group"
					case strings.Contains(statement, "qt_source_budget") || strings.HasPrefix(statement, "CREATE TEMP TABLE") && !strings.Contains(statement, "qt_groups"):
						phase = "source-projection"
					case strings.Contains(statement, "qt_groups") || strings.Contains(statement, "qt_group_ordinal") || strings.Contains(statement, "qt_identities") || strings.HasPrefix(statement, "ALTER TABLE"):
						phase = "grouping"
					case strings.HasPrefix(statement, "SAVEPOINT"):
						metric = true
					}
					if metric && phase == "result" {
						phase = "result-metrics"
					}
					phases[phase] += elapsed
					if strings.HasPrefix(statement, "RELEASE") || strings.HasPrefix(statement, "ROLLBACK TO") {
						metric = false
					}
				}
				db := sql.OpenDB(phaseConnector{base: base.Driver(), dsn: filepath.Join(b.TempDir(), "usage.db"), observe: observe, decline: mode == "general"})
				db.SetMaxOpenConns(1)
				defer db.Close()
				if _, err = db.Exec(ddl); err != nil {
					b.Fatal(err)
				}
				run := func() {
					tx, err := db.Begin()
					if err != nil {
						b.Fatal(err)
					}
					defer tx.Rollback()
					if mode == "native" {
						where, args := "tenant=?1", []any{"allowed"}
						if filtered {
							where += " AND provider=?2"
							args = append(args, "codex")
						}
						rows, e := tx.Query("SELECT day,COUNT(*),SUM(n0),AVG(n0) FROM usage WHERE "+where+" GROUP BY day ORDER BY day LIMIT 2", args...)
						if e != nil {
							b.Fatal(e)
						}
						for rows.Next() {
							var day, count, sum, avg any
							if e = rows.Scan(&day, &count, &sum, &avg); e != nil {
								b.Fatal(e)
							}
						}
						e = rows.Err()
						rows.Close()
						if e != nil {
							b.Fatal(e)
						}
					} else {
						out, e := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
						if e != nil {
							b.Fatal(e)
						}
						if out.Metrics[1].Buckets[0].Value != float64(20000) {
							b.Fatal(out)
						}
					}
					if err = tx.Commit(); err != nil {
						b.Fatal(err)
					}
				}
				runs := 0
				runBenchmark(b, func() {
					if runs == 1 {
						phases = map[string]time.Duration{}
					}
					runs++
					run()
				})
				b.StopTimer()
				for phase, elapsed := range phases {
					b.ReportMetric(float64(elapsed)/float64(b.N), phase+"-ns/op")
				}
				var pages, size int64
				if err := db.QueryRow("PRAGMA temp.page_count").Scan(&pages); err != nil {
					b.Fatal(err)
				}
				if err := db.QueryRow("PRAGMA temp.page_size").Scan(&size); err != nil {
					b.Fatal(err)
				}
				b.ReportMetric(float64(pages*size), "temp-bytes-highwater")
			})
		}
	}
}
