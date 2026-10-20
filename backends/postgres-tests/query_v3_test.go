package postgrestests

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	qt "github.com/Pythia-Software/query-table/backends/go"
	_ "github.com/lib/pq"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixture(t *testing.T) (*sql.DB, qt.QueryDatasetV3) {
	t.Helper()
	dsn := os.Getenv("QT_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("set QT_TEST_POSTGRES to a disposable PostgreSQL database")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("qt_test_%x", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + name); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", name)
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("postgres", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(16)
	t.Cleanup(func() { db.Close(); _, _ = admin.Exec("DROP SCHEMA " + name + " CASCADE"); admin.Close() })
	if _, err = db.Exec(`CREATE TABLE fixture(id text,k text,n double precision,at timestamptz,label text);
 INSERT INTO fixture VALUES('1','a',1,'2026-11-01T05:15:00Z','old'),('2','a',3,'2026-11-01T05:45:00Z',NULL),('3','a',3,'2026-11-01T06:15:00Z','tie'),('4','b',10,'2026-11-01T07:15:00Z','b'),('5','',2,NULL,'empty'),('6',NULL,4,NULL,'null')`); err != nil {
		t.Fatal(err)
	}
	yes := true
	schema := qt.Schema{Name: "fixture", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id": {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true}, "k": {Name: "k", Kind: qt.FieldText, Expr: "r.k", Sortable: true, ServerFilter: true},
		"n": {Name: "n", Kind: qt.FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true, ServerFilter: true, Groupable: &yes}, "at": {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", Sortable: true, ServerFilter: true, Groupable: &yes}, "label": {Name: "label", Kind: qt.FieldText, Expr: "r.label", Sortable: true, ServerFilter: true}}}
	return db, qt.QueryDatasetV3{Schema: schema, SourceSQL: "SELECT * FROM fixture", Dialect: "postgres", Scope: "one", Dataset: "fixture"}
}
func groupedQuery() qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: time.Now().UnixMilli(), Rows: true, Source: qt.WireQuery{Limit: 1, Offset: 3}, Grouping: &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}, {ID: "median", Op: "formula", Expression: "MEDIAN([n])"}, {ID: "example", Op: "row", Field: "label"}, {ID: "example_id", Op: "row", Field: "id"}}, Representative: &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: "last"}}}}, Result: qt.WireQuery{Select: []string{"k", "num", "total", "median", "example", "example_id"}, OrderBy: qt.OrderBys{{Field: "total", Dir: "desc"}}, Limit: 10}}
}
func TestPostgresGroupedExecution(t *testing.T) {
	db, d := fixture(t)
	q := groupedQuery()
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if out.Total != 4 || len(out.Rows) != 4 {
		t.Fatal(out)
	}
	var a map[string]any
	for _, r := range out.Rows {
		if r["k"] == "a" {
			a = r
		}
	}
	if a["num"] != float64(3) || a["total"] != float64(7) || a["median"] != float64(3) || a["example"] != "tie" || a["example_id"] != "3" || a[qt.GroupIdentityField] != `[["k","a"]]` {
		t.Fatal(a)
	}
	q.Result.Where = []qt.WhereTerm{{Field: "num", Op: ">=", Value: "2"}}
	q.Result.Limit = 1
	q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}, {ID: "shown", Op: "sum", Field: "total", Scope: "shownRows"}}
	filtered, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || filtered.Total != 1 || filtered.Metrics[0].Buckets[0].Value != float64(1) || filtered.Metrics[1].Buckets[0].Value != float64(7) {
		t.Fatal(filtered, err)
	}
	d.MaxSamplesPerGroup = 2
	if _, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
		t.Fatal("median sample budget ignored")
	}
}
func TestPostgresCalendarTimezone(t *testing.T) {
	db, d := fixture(t)
	q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: time.Now().UnixMilli(), Result: qt.WireQuery{Select: []string{"id"}, Limit: 10}, Metrics: []qt.AggSpec{{ID: "hours", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "hour", TimeZone: "America/New_York", IncludeEmpty: true, Range: "custom", Start: "2026-11-01T04:00:00Z", End: "2026-11-01T08:00:00Z"}}}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	metric := out.Metrics[0]
	if metric.GroupCount != 6 || len(metric.Buckets) != 6 || metric.Buckets[1].Value != float64(2) || metric.Buckets[2].Value != float64(1) || metric.Buckets[0].Value != float64(0) {
		t.Fatal(metric)
	}
}

func TestPostgresNarrowRowsAndArrays(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec(`ALTER TABLE fixture ADD COLUMN tags text[]; UPDATE fixture SET tags=ARRAY['one','two'] WHERE id='4'`); err != nil {
		t.Fatal(err)
	}
	d.Schema.Fields["tags"] = qt.FieldSpec{Name: "tags", Kind: qt.FieldTextArray, Expr: "r.tags"}
	q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: time.Now().UnixMilli(), Rows: true,
		Result: qt.WireQuery{Select: []string{"id", "tags"}, OrderBy: qt.OrderBys{{Field: "n", Dir: "desc"}}, Limit: 1}}
	plan, err := d.SourcePlan(context.Background(), q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(plan.Fields, []string{"id", "n", "tags"}) {
		t.Fatal(plan.Fields, err)
	}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || len(out.Rows) != 1 || out.Rows[0]["id"] != "4" || !reflect.DeepEqual(out.Rows[0]["tags"], []string{"one", "two"}) {
		t.Fatal(out, err)
	}
}
func TestPostgresComputedPartialAndGrouping(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec(qt.ComputedColumnsDDL); err != nil {
		t.Fatal(err)
	}
	store := qt.SQLComputedColumnStore{DB: db}
	for _, column := range []qt.ComputedColumn{{ID: "base", Label: "Base", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}, {ID: "child", Label: "Child", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[@computed/base]+1"}}, {ID: "broken", Label: "Broken", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[removed]"}}} {
		if _, err := store.Save(context.Background(), "one", "fixture", qt.SaveComputedColumnRequest{Column: column}); err != nil {
			t.Fatal(err)
		}
	}
	d.ComputedGroupable = map[string]bool{"child": true}
	d.ComputedFilterable = map[string]bool{"base": true}
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	description, err := d.DescribeComputedPartialIn(context.Background(), tx, []string{"child", "broken"}, qt.PlanOptions{})
	if err != nil || len(description.Diagnostics) != 1 || description.Execution.Profile != qt.ServerExpressionProfile || len(description.Execution.ResolvedRevisions) != 2 {
		t.Fatal(description, err)
	}
	tx.Rollback()
	q := groupedQuery()
	q.ExpectedRevisions = description.Execution.ResolvedRevisions
	q.Source.Where = []qt.WhereTerm{{Field: "@computed/base", Op: ">=", Value: "6"}}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"@computed/child"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "@computed/base"}}}
	q.Result = qt.WireQuery{Select: []string{"@computed/child", "num", "total"}, Limit: 10}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Total != 3 {
		t.Fatal(out, err)
	}
	q.ExpectedRevisions["base"] = "stale"
	if _, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
		t.Fatal("stale transitive revision accepted")
	}
}
func TestPostgresSnapshotTransactionsAndConcurrentQuota(t *testing.T) {
	db, _ := fixture(t)
	if _, err := db.Exec(qt.QuerySnapshotsDDL); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := qt.SQLQuerySnapshotStore{DB: db}
	snapshot := qt.QuerySnapshot{Version: 1, Code: strings.Repeat("a", 22), Token: "2j.e30"}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.SaveIn(ctx, tx, "one", "fixture", snapshot); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	if _, err = store.Resolve(ctx, "one", "fixture", snapshot.Code); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("rollback persisted snapshot", err)
	}
	save := func(snapshot qt.QuerySnapshot) (qt.QuerySnapshot, error) {
		if err := qt.ValidateQuerySnapshot(snapshot); err != nil {
			return qt.QuerySnapshot{}, err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return qt.QuerySnapshot{}, err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('query-table-test-quota'))`); err != nil {
			return qt.QuerySnapshot{}, err
		}
		previous, err := store.ResolveIn(ctx, tx, "one", "fixture", snapshot.Code)
		if !errors.Is(err, sql.ErrNoRows) && err != nil {
			return previous, err
		}
		if errors.Is(err, sql.ErrNoRows) {
			var count int
			if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM query_table_query_snapshots WHERE scope='one'`).Scan(&count); err != nil {
				return previous, err
			}
			if count >= 3 {
				return previous, qt.ErrQuerySnapshotQuota
			}
		}
		saved, err := store.SaveIn(ctx, tx, "one", "fixture", snapshot)
		if err != nil {
			return saved, err
		}
		return saved, tx.Commit()
	}
	var wait sync.WaitGroup
	var lock sync.Mutex
	saved := []qt.QuerySnapshot{}
	unexpected := []error{}
	for i := 0; i < 12; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			candidate := snapshot
			candidate.Code = fmt.Sprintf("%022d", i)
			result, err := save(candidate)
			lock.Lock()
			defer lock.Unlock()
			if err == nil {
				saved = append(saved, result)
			} else if !errors.Is(err, qt.ErrQuerySnapshotQuota) {
				unexpected = append(unexpected, err)
			}
		}(i)
	}
	wait.Wait()
	if len(saved) != 3 || len(unexpected) > 0 {
		t.Fatal(saved, unexpected)
	}
	if same, err := save(saved[0]); err != nil || same != saved[0] {
		t.Fatal("idempotent save failed at quota", same, err)
	}
	changed := saved[0]
	changed.Token = "2j.eyJsIjoyNX0"
	if _, err := save(changed); !errors.Is(err, qt.ErrQuerySnapshotConflict) {
		t.Fatal(err)
	}
	malformed := saved[0]
	malformed.Token = "2j.bnVsbA"
	if _, err := save(malformed); err == nil {
		t.Fatal("malformed direct write accepted")
	}
}

func TestPostgresHostGroupBudget(t *testing.T) {
	db, d := fixture(t)
	q := groupedQuery()
	q.Result.Limit, q.Result.Offset = 1, 1
	for _, budget := range []int{0, 10_000, 100_000, 100_001, -1} {
		d.MaxGroups = budget
		out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if budget < 0 || budget > 100_000 {
			var diag *qt.PlanDiagnostic
			if !errors.As(err, &diag) || diag.Code != "resource_limit" || diag.Message != "invalid host execution budgets" {
				t.Fatalf("budget %d: expected host budget diagnostic, got %v", budget, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("budget %d: %v", budget, err)
		}
		want := budget
		if want == 0 {
			want = 2000
		}
		if caps := d.Capabilities(); caps.MaxGroups != want {
			t.Fatalf("budget %d: capabilities=%#v", budget, caps)
		}
		if out.SourceTotal != 6 || out.Total != 4 || len(out.Rows) != 1 {
			t.Fatalf("budget %d: result=%#v", budget, out)
		}
	}
	// The full grouping population is checked before result paging.
	d.MaxGroups = 3
	var diag *qt.PlanDiagnostic
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "resource_limit" || diag.Message != "group population exceeds host budget" {
		t.Fatalf("group budget before paging: %v", err)
	}
}
