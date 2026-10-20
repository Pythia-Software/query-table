package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"reflect"
	"testing"
	"time"
)

func setupV3(t *testing.T) (*sql.DB, qt.QueryDatasetV3) {
	db, _ := setupV2(t)
	_, err := db.Exec(`CREATE TABLE grouped(id TEXT,k TEXT,n REAL,at TEXT,label TEXT);
 INSERT INTO grouped VALUES('1','a',1,'2026-11-01T05:15:00.000Z','old'),('2','a',3,'2026-11-01T05:45:00.000Z',NULL),('3','a',3,'2026-11-01T06:15:00.000Z','tie'),('4','b',10,'2026-11-01T07:15:00.000Z','b'),('5','',2,NULL,'empty'),('6',NULL,4,NULL,'null');`)
	if err != nil {
		t.Fatal(err)
	}
	yes := true
	schema := qt.Schema{Name: "grouped", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":    {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true},
		"k":     {Name: "k", Kind: qt.FieldText, Expr: "r.k", Sortable: true, ServerFilter: true},
		"n":     {Name: "n", Kind: qt.FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true, ServerFilter: true, Groupable: &yes},
		"at":    {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", SQLiteDatetimeFormat: "utc-millis", Sortable: true, ServerFilter: true, Groupable: &yes},
		"label": {Name: "label", Kind: qt.FieldText, Expr: "r.label", Sortable: true, ServerFilter: true},
	}}
	return db, qt.QueryDatasetV3{Schema: schema, SourceSQL: "SELECT * FROM grouped", Dialect: "sqlite", Scope: "one", Dataset: "runs"}
}
func groupedRequest() qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).UnixMilli(), Rows: true,
		Source:   qt.WireQuery{Limit: 1, Offset: 2},
		Grouping: &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}, {ID: "average", Op: "avg", Field: "n"}, {ID: "median", Op: "formula", Expression: "MEDIAN([n])"}, {ID: "example", Op: "row", Field: "label"}, {ID: "example_id", Op: "row", Field: "id"}}, Representative: &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: "last"}}}},
		Result:   qt.WireQuery{Select: []string{"k", "num", "total", "average", "median", "example", "example_id"}, OrderBy: qt.OrderBys{{Field: "total", Dir: "desc"}}, Limit: 10},
	}
}
func TestV3GroupingStagesAndRepresentative(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
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
	q.Source.Limit = 999
	q.Source.Offset = 0
	same, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(out.Rows, same.Rows) {
		t.Fatal("source paging changed groups", same, err)
	}
	q.Result.Where = []qt.WhereTerm{{Field: "num", Op: ">=", Value: "2"}}
	q.Result.Limit = 1
	q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}, {ID: "sum", Op: "sum", Field: "total", Scope: "shownRows"}}
	filtered, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if filtered.Total != 1 || filtered.Metrics[0].Buckets[0].Value != float64(1) || filtered.Metrics[1].Buckets[0].Value != float64(7) {
		t.Fatal(filtered)
	}
	// One shared representative preserves the chosen record's NULL value.
	q.Grouping.Representative.OrderBy = []qt.OrderBy{{Field: "id", Dir: "asc", Nulls: "last"}}
	q.Source.Where = []qt.WhereTerm{{Field: "id", Op: "!=", Value: "1"}}
	selected, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if selected.Rows[0]["example_id"] != "2" || selected.Rows[0]["example"] != nil {
		t.Fatal(selected.Rows)
	}
}
func TestV3GroupingBudgetsIdentityAndRollback(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	for _, modify := range []func(*qt.QueryDatasetV3){func(d *qt.QueryDatasetV3) { d.MaxGroups = 1 }, func(d *qt.QueryDatasetV3) { d.MaxPopulation = 2 }, func(d *qt.QueryDatasetV3) { d.MaxStagingBytes = 1 }} {
		copy := d
		modify(&copy)
		if _, err := copy.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
			t.Fatal("budget ignored")
		}
	}
	if _, err := db.Exec(`INSERT INTO grouped VALUES('1','a',0,NULL,'duplicate');`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
		t.Fatal("duplicate non-representative identity accepted")
	}
	var leaked int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_temp_master WHERE name LIKE 'qt_v3_%'`).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatal("leaked temporary source", leaked, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := d.Execute(ctx, db, q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestV3CalendarRepeatedHoursAndEmptyBuckets(t *testing.T) {
	db, d := setupV3(t)
	q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Now().UnixMilli(), Result: qt.WireQuery{Select: []string{"id"}, Limit: 10}, Metrics: []qt.AggSpec{{ID: "hours", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "hour", TimeZone: "America/New_York", IncludeEmpty: true, Range: "custom", Start: "2026-11-01T04:00:00Z", End: "2026-11-01T08:00:00Z"}}}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	metric := out.Metrics[0]
	if metric.GroupCount != 6 || len(metric.Buckets) != 6 {
		t.Fatal(metric)
	}
	for i, b := range metric.Buckets[:5] {
		want := time.Date(2026, 11, 1, 4+i, 0, 0, 0, time.UTC).Format("2006-01-02T15:04:05.000Z")
		if b.Keys[0] != want {
			t.Fatal(b, want)
		}
	}
	if metric.Buckets[1].Value != float64(2) || metric.Buckets[2].Value != float64(1) || metric.Buckets[0].Value != float64(0) || metric.Buckets[5].Keys[0] != nil {
		t.Fatal(metric)
	}
	q.Metrics[0].Op = "avg"
	q.Metrics[0].Field = "n"
	avg, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || avg.Metrics[0].Buckets[0].Value != nil {
		t.Fatal(avg, err)
	}
	q.Metrics[0].Op = "sum"
	sum, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || sum.Metrics[0].Buckets[0].Value != float64(0) {
		t.Fatal(sum, err)
	}
	q.Metrics[0].GroupLimit = 1
	limited, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || limited.Metrics[0].GroupCount != 6 || len(limited.Metrics[0].Buckets) != 1 {
		t.Fatal(limited, err)
	}
}
func TestV3ComputedGroupingAndNarrowSource(t *testing.T) {
	db, d := setupV3(t)
	if _, err := db.Exec(qt.SQLiteComputedColumnsDDL); err != nil {
		t.Fatal(err)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	for _, c := range []qt.ComputedColumn{{ID: "base", Label: "base", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}, {ID: "child", Label: "child", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[@computed/base]+1"}}} {
		if _, err := store.Save(context.Background(), "one", "runs", qt.SaveComputedColumnRequest{Column: c}); err != nil {
			t.Fatal(err)
		}
	}
	d.ComputedGroupable = map[string]bool{"child": true}
	d.ComputedFilterable = map[string]bool{"base": true}
	q := groupedRequest()
	q.ExpectedRevisions = map[string]string{"base": "1", "child": "1"}
	q.Source.Where = []qt.WhereTerm{{Field: "@computed/base", Op: ">=", Value: "6"}}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"@computed/child"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}}}
	q.Result = qt.WireQuery{Select: []string{"@computed/child", "num"}, Limit: 10}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Total != 3 {
		t.Fatal(out, err)
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	plan, err := d.SourcePlan(context.Background(), q, qt.PlanOptions{Resolver: qt.SQLiteComputedDefinitionResolver{Tx: tx, Scope: "one", Dataset: "runs"}})
	if err != nil {
		t.Fatal(err)
	}
	if containsTest(plan.BaseFields, "label") || !containsTest(plan.BaseFields, "n") || !containsTest(plan.BaseFields, "id") {
		t.Fatal(plan.BaseFields)
	}
	q.ExpectedRevisions["base"] = "stale"
	if _, err = d.SourcePlan(context.Background(), q, qt.PlanOptions{Resolver: qt.SQLiteComputedDefinitionResolver{Tx: tx, Scope: "one", Dataset: "runs"}}); err == nil {
		t.Fatal("stale canonical revision accepted")
	}
}
func containsTest(values []string, needle string) bool {
	for _, v := range values {
		if v == needle {
			return true
		}
	}
	return false
}

func TestV3HostGroupBudget(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
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
