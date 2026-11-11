package sqlitetests

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

const labelTrendRows = `CREATE TABLE observations(id TEXT PRIMARY KEY,message_id,day,family COLLATE NOCASE,occurred_at TEXT);
 INSERT INTO observations VALUES
 ('1','m1','d1','A','2026-10-01T00:00:00Z'),
 ('2','m1','d1','A','2026-10-01T00:00:00Z'),
 ('3','m1','d1','B','2026-10-01T00:00:00Z'),
 ('4','m2','d1','A','2026-10-01T00:00:00Z'),
 ('5','m2','d1','a','2026-10-01T00:00:00Z'),
 ('6',NULL,'d1','A','2026-10-01T00:00:00Z'),
 ('7','','d1','','2026-10-01T00:00:00Z'),
 ('8','m3',NULL,NULL,'2026-10-02T00:00:00Z'),
 ('9','m4','','A','2026-10-02T00:00:00Z'),
 ('10','excluded','d1','A','2020-10-01T00:00:00Z');`

func TestLabelTrendExact(t *testing.T) {
	db, d, q := labelTrendFixture(t, 2000)
	want := labelTrendNative(t, db, q)
	got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	checkLabelTrend(t, got, want)
	if got.Total != 4000 || len(got.Metrics[0].Buckets) != 360 || len(got.Metrics[1].Buckets) != 90 {
		t.Fatal("wrong population or groups")
	}
}

// Compare batches with individually executed metrics: the latter retain the
// preexisting compiler/reduction paths, including their bucket error keys.
func TestTextDistinctBatchParity(t *testing.T) {
	for _, scenario := range []string{"overlap", "invalid-key", "invalid-common-key", "invalid-input", "invalid-utf8", "long-key", "long-input", "inherited-error", "source-filter", "metric-filters", "scope", "empty", "empty-scalar", "reordered-keys", "enum", "min-count", "different-fields"} {
		t.Run(scenario, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, labelTrendRows)
			exec := func(statement string, args ...any) {
				t.Helper()
				if _, err := db.Exec(statement, args...); err != nil {
					t.Fatal(err)
				}
			}
			_, d, q := labelTrendFixture(t, 1)
			switch scenario {
			case "invalid-key":
				exec("UPDATE observations SET family=40+CAST(id AS INTEGER) WHERE id IN ('2','3')")
			case "invalid-common-key":
				exec("UPDATE observations SET day=42 WHERE id='2'")
			case "invalid-input":
				exec("UPDATE observations SET message_id=x'61' WHERE id='2'")
			case "invalid-utf8":
				exec("UPDATE observations SET message_id=CAST(x'80' AS TEXT) WHERE id='2'")
			case "long-key":
				exec("UPDATE observations SET family=? WHERE id='2'", strings.Repeat("x", 100001))
			case "long-input":
				exec("UPDATE observations SET message_id=? WHERE id='2'", strings.Repeat("x", 100001))
			case "inherited-error":
				f := d.Schema.Fields["family"]
				f.ValueErrorExpr = "CASE WHEN r.id='2' THEN 'text_range' END"
				d.Schema.Fields["family"] = f
			case "source-filter":
				q.Result.Where = append(q.Result.Where, qt.WhereTerm{Field: "family", Op: "=", Value: "A"})
				d.SourceSQL += " WHERE id!=?1"
				d.SourceArgs = []any{"3"}
			case "metric-filters":
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: "filtered", Op: "count_distinct", Field: "message_id", GroupBy: []string{"day"}, Where: []qt.WhereTerm{{Field: "family", Op: "=", Value: "A"}}})
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: "filtered-detail", Op: "count_distinct", Field: "message_id", GroupBy: []string{"day", "family"}, Where: q.Metrics[2].Where})
			case "scope":
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: "page", Op: "count_distinct", Field: "message_id", GroupBy: []string{"day"}, Scope: "shownRows"})
				q.Result.Limit = 2
				q.Result.Offset = 1
			case "empty", "empty-scalar":
				q.Result.Where = append(q.Result.Where, qt.WhereTerm{Field: "id", Op: "=", Value: "missing"})
				if scenario == "empty-scalar" {
					q.Metrics[1].GroupBy = nil
				}
			case "reordered-keys":
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: "reordered", Op: "count_distinct", Field: "message_id", GroupBy: []string{"family", "day"}})
			case "enum":
				f := d.Schema.Fields["family"]
				f.Kind = qt.FieldEnum
				d.Schema.Fields["family"] = f
			case "min-count":
				q.Metrics[0].MinCount = qt.MetricMinCount{Min: 2}
				q.Metrics[0].GroupLimit = 1
				q.Metrics[0].Sort = []qt.MetricSort{{Key: "value", Dir: "desc"}}
			case "different-fields":
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: "families", Op: "count_distinct", Field: "family", GroupBy: []string{"day"}})
			}
			want := []qt.MetricResult{}
			for _, m := range q.Metrics {
				single := q
				single.Metrics = []qt.AggSpec{m}
				r, err := d.Execute(context.Background(), db, single, qt.PlanOptions{})
				if err != nil {
					t.Fatal(err)
				}
				want = append(want, r.Metrics[0])
			}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			log.reset(nil)
			got, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual([]qt.MetricResult(got.Metrics), want) {
				t.Fatalf("batch differs\ngot: %#v\nwant: %#v", got.Metrics, want)
			}
			if log.count(" AS WITH qt_text_distinct_input") == 0 {
				t.Fatal("shared text input not exercised")
			}
			assertNoReductions(t, tx)
			if scenario == "overlap" {
				found := false
				for _, b := range got.Metrics[1].Buckets {
					if len(b.Keys) == 1 && b.Keys[0] == "d1" {
						found = true
						if b.Value != float64(3) || b.Count != 7 {
							t.Fatal("overlapping families or NULL/empty counted incorrectly", b)
						}
					}
				}
				if !found {
					t.Fatalf("missing denominator: %#v", got.Metrics[1])
				}
				// Reusing the same caller transaction must observe subsequent writes.
				if _, err = tx.Exec("UPDATE observations SET message_id='new' WHERE id='2'"); err != nil {
					t.Fatal(err)
				}
				next, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if reflect.DeepEqual(next.Metrics, got.Metrics) {
					t.Fatal("input cache escaped its execution")
				}
				assertNoReductions(t, tx)
			}
		})
	}
}

func TestTextDistinctInputSingleEvaluation(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, labelTrendRows)
	_, d, q := labelTrendFixture(t, 1)
	f := d.Schema.Fields["message_id"]
	f.Expr = "qt_test_metric_probe(r.message_id)"
	d.Schema.Fields["message_id"] = f
	metricProbeCalls.Store(0)
	for _, c := range sqliteCalls {
		c.Store(0)
	}
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if n := metricProbeCalls.Load(); n != 9 {
		t.Fatalf("source expression evaluated %d times; want 9", n)
	}
	if n := sqliteCalls["qt_v2_field_error"].Load(); n != 27 {
		t.Fatalf("typed checks %d; want 27", n)
	}
}

func TestTextDistinctFailuresAndCleanup(t *testing.T) {
	for _, scenario := range []string{"statement", "member-expression", "budget", "budget-sibling", "cancel", "revisions"} {
		t.Run(scenario, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, labelTrendRows)
			_, d, q := labelTrendFixture(t, 1)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			opts := qt.PlanOptions{}
			switch scenario {
			case "statement":
				log.reset(func(s string) error {
					if strings.HasPrefix(s, "CREATE TEMP TABLE") && strings.Contains(s, "qt_text_distinct_input") {
						return errors.New("injected CTAS failure")
					}
					return nil
				})
			case "member-expression":
				f := d.Schema.Fields["family"]
				f.Expr = "json_extract(r.family,'$')"
				d.Schema.Fields["family"] = f
			case "budget":
				d.MaxGroups = 2
				q.Metrics[0].GroupLimit = 1
			case "budget-sibling":
				d.MaxGroups = 3
			case "cancel":
				log.reset(func(s string) error {
					if strings.HasPrefix(s, "CREATE TEMP TABLE") && strings.Contains(s, "qt_text_distinct_input") {
						cancel()
						return context.Canceled
					}
					return nil
				})
			case "revisions":
				q.ExpectedRevisions = map[string]string{"hidden": "1"}
				opts.Resolver = qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) {
					return qt.ComputedColumn{ID: "hidden", Revision: "2"}, nil
				})
			}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			got, err := d.ExecuteIn(ctx, tx, q, opts)
			switch scenario {
			case "cancel":
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation lost", err)
				}
			case "revisions":
				if err == nil || log.count("qt_text_distinct_input") != 0 {
					t.Fatal("stale revision executed", err)
				}
			default:
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "statement" {
					for _, m := range got.Metrics {
						if m.Error != "" {
							t.Fatal(m)
						}
					}
				}
				if scenario == "member-expression" && (got.Metrics[0].Error == "" || got.Metrics[1].Error != "") {
					t.Fatal("member failure escaped isolation", got.Metrics)
				}
				if scenario == "budget-sibling" && (got.Metrics[0].ErrorCode != qt.ErrorCodeResourceLimit || got.Metrics[1].Error != "" || log.count(" AS WITH qt_text_distinct_input") != 2) {
					t.Fatal("rollback prevented sibling recreation", got.Metrics)
				}
				if scenario == "budget" {
					for _, m := range got.Metrics {
						if m.ErrorCode != qt.ErrorCodeResourceLimit {
							t.Fatal("group budget bypassed", m)
						}
					}
				}
			}
			assertNoReductions(t, tx)
		})
	}
}

// A failure can occur after SQLite has created the TEMP table. It must still
// be cleaned up when the ordinary per-metric fallback succeeds.
func TestTextDistinctPartialCTASCleanup(t *testing.T) {
	log := &statementLog{}
	db := hookedDBWithExecHook(t, log, labelTrendRows, func(ctx context.Context, conn driver.Conn, s string) error {
		if strings.HasPrefix(s, "CREATE TEMP TABLE") && strings.Contains(s, "qt_text_distinct_input") {
			name := strings.Fields(s)[3]
			if _, err := conn.(driver.ExecerContext).ExecContext(ctx, "CREATE TEMP TABLE "+name+"(unused)", nil); err != nil {
				return err
			}
			return errors.New("failed after create")
		}
		return nil
	})
	_, d, q := labelTrendFixture(t, 1)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	got, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
	if err != nil || got.Metrics[0].Error != "" || got.Metrics[1].Error != "" {
		t.Fatal(got, err)
	}
	assertNoReductions(t, tx)
}

func TestTextDistinctCancellationDuringInput(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, labelTrendRows)
	_, d, q := labelTrendFixture(t, 1)
	f := d.Schema.Fields["message_id"]
	f.Expr = "qt_test_metric_probe(r.message_id)"
	d.Schema.Fields["message_id"] = f
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	metricProbeCalls.Store(0)
	metricProbeCancel, metricProbeCancelAfter = cancel, 4
	defer func() { metricProbeCancel = nil }()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = d.ExecuteIn(ctx, tx, q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal("input cancellation lost", err)
	}
	if metricProbeCalls.Load() <= 4 {
		t.Fatal("input not exercised")
	}
	assertNoReductions(t, tx)
}
