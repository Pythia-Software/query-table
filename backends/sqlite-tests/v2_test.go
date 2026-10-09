package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func setupV2(t *testing.T) (*sql.DB, qt.SQLiteV2Dataset) {
	db, v1 := setup(t)
	f := v1.Schema.Fields["n"]
	f.ExpressionNumeric = true
	v1.Schema.Fields["n"] = f
	return db, qt.SQLiteV2Dataset{Schema: v1.Schema, SourceSQL: "SELECT * FROM runs WHERE tenant=?1", SourceArgs: []any{"one"}, Scope: "one", Dataset: "runs"}
}
func metricV2(expression string) qt.MetricQuery {
	return qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{{ID: "m", Expression: expression}}}
}
func runMetric(t *testing.T, db *sql.DB, d qt.SQLiteV2Dataset, q qt.MetricQuery) qt.SQLiteMetricV2 {
	t.Helper()
	r, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	return r.Metrics.Metrics[0]
}
func TestV2Formulas(t *testing.T) {
	db, d := setupV2(t)
	for _, c := range []struct {
		source string
		value  any
		code   string
	}{
		{"SUM([n])/COUNT([n])", float64(4), ""}, {"MEDIAN([n])", float64(4), ""}, {"AVG([n]+2)", float64(6), ""},
		{"COUNT()", float64(4), ""}, {"COUNT_DISTINCT([n])", float64(3), ""},
		{"IF(COUNT()>0,SUM([n]),1/0)", float64(12), ""}, {"COALESCE(SUM([n]),1/0)", float64(12), ""},
		{"SUM([n])/0", nil, "divide_by_zero"}, {"SUM([n]*1e100)", nil, "numeric_range"},
		{"IF(FALSE,1/0,COUNT())", float64(4), ""},
	} {
		t.Run(c.source, func(t *testing.T) {
			m := runMetric(t, db, d, metricV2(c.source))
			b := m.Buckets[0]
			if !reflect.DeepEqual(b.Value, c.value) {
				t.Fatalf("got %#v want %#v", b, c.value)
			}
			if c.code == "" && b.Error != "" || c.code != "" && (b.Error != c.code) {
				t.Fatalf("error %#v want %s", b.Error, c.code)
			}
			if m.ProcessedRows != 4 || m.GroupCount != 1 || m.Coverage != "exact" {
				t.Fatal(m)
			}
		})
	}
}
func TestV2PairedGroupLimitScope(t *testing.T) {
	db, d := setupV2(t)
	q := metricV2("SUM([n])")
	q.Metrics[0].ExpressionY = "COUNT()"
	q.Metrics[0].GroupBy = []string{"flag"}
	q.Metrics[0].GroupLimit = 1
	m := runMetric(t, db, d, q)
	if m.GroupCount != 3 || len(m.Buckets) != 1 || m.Buckets[0].Keys[0] != true || m.Buckets[0].Value != float64(8) || *m.Buckets[0].Y != float64(2) {
		t.Fatal(m)
	}
	q.Limit = 2
	q.Offset = 1
	q.OrderBy = []qt.OrderBy{{Field: "n", Dir: "desc"}}
	q.Metrics[0].GroupBy = nil
	q.Metrics[0].Scope = "shownRows"
	m = runMetric(t, db, d, q)
	if m.ProcessedRows != 2 || m.Buckets[0].Value != float64(6) || *m.Buckets[0].Y != float64(2) {
		t.Fatal(m)
	}
}

func TestV2RejectsInvalidSortDirection(t *testing.T) {
	db, d := setupV2(t)
	for _, source := range []string{"request", "default", "tiebreak"} {
		for _, path := range []string{"rows", "shownRows"} {
			t.Run(source+"/"+path, func(t *testing.T) {
				dataset := d
				order := []qt.OrderBy{{Field: "id", Dir: "sideways"}}
				switch source {
				case "default":
					dataset.Schema.DefaultSort = order
					order = nil
				case "tiebreak":
					dataset.Schema.TiebreakSort = order
					order = []qt.OrderBy{{Field: "id", Dir: "asc"}}
				}
				var err error
				if path == "rows" {
					q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, OrderBy: order, Limit: 2}}
					_, err = dataset.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{})
				} else {
					q := metricV2("COUNT()")
					q.OrderBy = order
					q.Limit = 2
					q.Metrics[0].Scope = "shownRows"
					_, err = dataset.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
				}
				var diagnostic *qt.PlanDiagnostic
				if !errors.As(err, &diagnostic) || diagnostic.Code != "sort" || diagnostic.Message != "direction must be asc or desc" {
					t.Fatalf("expected sort direction diagnostic, got %v", err)
				}
			})
		}
	}
}

func TestV2EmptyAndStorageErrors(t *testing.T) {
	db, d := setupV2(t)
	q := metricV2("SUM([n])")
	q.Where = []qt.WhereTerm{{Field: "n", Op: ">", Value: "1000"}}
	m := runMetric(t, db, d, q)
	if m.ProcessedRows != 0 || m.Buckets[0].Value != nil || m.Buckets[0].Error != "" {
		t.Fatal(m)
	}
	if _, e := db.Exec("UPDATE runs SET n='garbage' WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	m = runMetric(t, db, d, metricV2("SUM([n])"))
	if m.Buckets[0].Error != "storage_type" {
		t.Fatal(m)
	}
	m = runMetric(t, db, d, metricV2("IF(TRUE,COUNT(),SUM([n]))"))
	if m.Buckets[0].Value != float64(4) || m.Buckets[0].Error != "" {
		t.Fatal(m)
	}
}
func TestV2ComputedRowsAndRevisionSnapshot(t *testing.T) {
	db, d := setupV2(t)
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	for _, c := range []qt.ComputedColumn{{ID: "neg", Label: "Negative", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "-[n]"}}, {ID: "twice", Label: "Twice", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[@computed/neg]*2"}}} {
		if _, e := store.Save(context.Background(), "one", "runs", qt.SaveComputedColumnRequest{Column: c}); e != nil {
			t.Fatal(e)
		}
	}
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	execution, e := d.DescribeComputedIn(context.Background(), tx, []string{"twice", "neg"}, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, ExpectedRevisions: execution.ResolvedRevisions, WireQuery: qt.WireQuery{Select: []string{"id", "tags", "stamp", "@computed/twice"}, OrderBy: []qt.OrderBy{{Field: "@computed/neg", Dir: "desc"}}, Limit: 2}}
	metric := metricV2("SUM([@computed/twice])")
	metric.ExpectedRevisions = execution.ResolvedRevisions
	metric.OrderBy = q.OrderBy
	metric.Limit = q.Limit
	r, e := d.ExecuteV2In(context.Background(), tx, &q, &metric, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if r.Rows.Total != 4 || r.Rows.Rows[0]["id"] != "a" || r.Rows.Computed[0].Values["twice"].Value != float64(-4) || r.Metrics.Metrics[0].Buckets[0].Value != float64(-24) {
		t.Fatal(r)
	}
	q.ExpectedRevisions = map[string]string{"twice": "1", "neg": "stale"}
	if _, e = d.ExecuteV2In(context.Background(), tx, &q, nil, qt.PlanOptions{}); e == nil {
		t.Fatal("accepted stale dependency")
	}
}
func TestV2ValidationAndBudgets(t *testing.T) {
	db, d := setupV2(t)
	for _, change := range []func(*qt.MetricQuery){func(q *qt.MetricQuery) { q.Profile = qt.ServerExpressionProfile }, func(q *qt.MetricQuery) { q.Diagnostics = []any{"residual"} }, func(q *qt.MetricQuery) { q.PlanToken = "unvalidated" }, func(q *qt.MetricQuery) { q.Snapshot = "unbound" }, func(q *qt.MetricQuery) {
		q.Metrics[0].Distribution = &qt.MetricDistribution{Kind: "unknown", Input: "[n]"}
	}, func(q *qt.MetricQuery) { q.Metrics[0].Expression = "SUM(SUM([n]))" }, func(q *qt.MetricQuery) { q.Metrics[0].Expression = "SUM([n])+[n]" }} {
		q := metricV2("SUM([n])")
		change(&q)
		if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
			t.Fatal("invalid query accepted", q)
		}
	}
	d.MaxPopulation = 3
	q := metricV2("COUNT()")
	if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
		t.Fatal("population budget ignored")
	}
	d.MaxPopulation = 0
	d.MaxGroups = 2
	q.Metrics[0].GroupBy = []string{"flag"}
	q.Metrics[0].GroupLimit = 1
	if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
		t.Fatal("group budget ignored before topN")
	}
	d.MaxGroups = 0
	q = metricV2("COUNT()")
	q.Where = []qt.WhereTerm{{Field: "text", Op: "matches_regex", Value: "(?i)^école"}}
	m := runMetric(t, db, d, q)
	if m.Buckets[0].Value != float64(2) {
		t.Fatal(m)
	}
	if !d.Capabilities().Distributions || d.Capabilities().Profile != qt.SQLiteExpressionProfile {
		t.Fatal(d.Capabilities())
	}
}

func TestV2NumericAccuracyAndGuards(t *testing.T) {
	db, d := setupV2(t)
	d.Schema.Fields = map[string]qt.FieldSpec{"id": d.Schema.Fields["id"], "n": d.Schema.Fields["n"]}
	for _, c := range []struct {
		values, expression string
		value              any
		code               string
	}{
		{"(0.1),(0.2),(0.3)", "SUM([n])", float64(0.6), ""},
		{"(9007199254740990),(1),(-9007199254740990)", "AVG([n])", float64(1.0 / 3), ""},
		{"(9007199254740990),(1),(-9007199254740990)", "SUM([n])", nil, "unsafe_integer"},
		{"(9007199254740992)", "COUNT([n])", float64(1), ""},
		{"(9007199254740992)", "MIN([n])", nil, "unsafe_integer"},
		{"(1e-300)", "SUM([n]/2)", nil, "numeric_range"},
		{"(1),(2),(3),(4)", "MEDIAN([n])", float64(2.5), ""},
		{"(NULL),(NULL)", "AVG([n])", nil, ""},
	} {
		t.Run(c.expression+c.values, func(t *testing.T) {
			d.SourceSQL = "WITH samples(n) AS (VALUES " + c.values + ") SELECT n,printf('%d',row_number() OVER()) AS id FROM samples"
			d.SourceArgs = nil
			m := runMetric(t, db, d, metricV2(c.expression))
			b := m.Buckets[0]
			if !reflect.DeepEqual(b.Value, c.value) || b.Error != c.code {
				t.Fatalf("got %#v want %v/%s", b, c.value, c.code)
			}
		})
	}
}
func TestV2MedianBudget(t *testing.T) {
	db, d := setupV2(t)
	d.Schema.Fields = map[string]qt.FieldSpec{"id": d.Schema.Fields["id"], "n": d.Schema.Fields["n"]}
	d.SourceSQL = "WITH RECURSIVE samples(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM samples WHERE n<100001) SELECT n,CAST(n AS TEXT) AS id FROM samples"
	d.SourceArgs = nil
	m := runMetric(t, db, d, metricV2("MEDIAN([n])"))
	if m.Buckets[0].Error != "resource_limit" || m.Buckets[0].Value != nil || m.ProcessedRows != 100001 {
		t.Fatal(m)
	}
}
func TestV2LazyLogicAndTextCollation(t *testing.T) {
	db, d := setupV2(t)
	for _, c := range []struct {
		formula string
		value   any
	}{{"FALSE AND SUM([n])/0=1", false}, {"TRUE OR SUM([n])/0=1", true}, {"MIN([text])", ""}, {"COUNT_DISTINCT([text])", float64(3)}, {"NULLIF(COUNT(),4)", nil}} {
		m := runMetric(t, db, d, metricV2(c.formula))
		if m.Buckets[0].Value != c.value || m.Buckets[0].Error != "" {
			t.Fatal(c, m)
		}
	}
}
func TestV2SnapshotAndFullRevisionEnvelope(t *testing.T) {
	db, d := setupV2(t)
	ctx := context.Background()
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	def := qt.ComputedColumn{ID: "unused", Label: "Unused", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]+1"}}
	if _, e := store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: def}); e != nil {
		t.Fatal(e)
	}
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	handshake, e := d.DescribeComputedIn(ctx, tx, []string{"unused"}, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, ExpectedRevisions: handshake.ResolvedRevisions, PlanToken: "valid", Snapshot: "held", WireQuery: qt.WireQuery{Select: []string{"id", "n"}, Limit: 4}}
	m := metricV2("SUM([n])")
	m.Limit = q.Limit
	m.ExpectedRevisions = q.ExpectedRevisions
	m.PlanToken = q.PlanToken
	m.Snapshot = q.Snapshot
	o := qt.PlanOptions{ValidatePlanToken: func(context.Context, string) error { return nil }, ValidateSnapshot: func(context.Context, string) error { return nil }}
	if _, e = db.Exec("UPDATE runs SET n=20 WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	revision := "1"
	def.Expression.Source = "[n]+2"
	if _, e = store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: def, ExpectedRevision: &revision}); e != nil {
		t.Fatal(e)
	}
	r, e := d.ExecuteV2In(ctx, tx, &q, &m, o)
	if e != nil {
		t.Fatal(e)
	}
	if r.Metrics.Metrics[0].Buckets[0].Value != float64(12) || r.Rows.Rows[0]["n"] != int64(2) || r.Rows.Execution.ResolvedRevisions["unused"] != "1" || r.Rows.Execution.Fields["@computed/unused"].Type != "number" || r.Rows.Execution.PlanToken != "valid" || r.Rows.Execution.Snapshot != "held" {
		t.Fatal(r)
	}
	q.Snapshot = ""
	q.PlanToken = ""
	if _, e = d.ExecuteV2(ctx, db, &q, nil, qt.PlanOptions{}); e == nil {
		t.Fatal("stale unused handshake revision accepted")
	}
}
func TestV2AlternateAndRegexSorting(t *testing.T) {
	db, d := setupV2(t)
	f := d.Schema.Fields["text"]
	f.SortExpr = "r.stamp"
	f.SQLiteSortField = "stamp"
	d.Schema.Fields["text"] = f
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "text", Dir: "desc"}}, Limit: 2}}
	r, e := d.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if r.Rows.Rows[0]["id"] != "d" || r.Rows.Rows[1]["id"] != "a" {
		t.Fatal(r)
	}
	q.OrderBy = []qt.OrderBy{{Field: "id", Dir: "desc", Extract: &qt.RegexExtract{Regex: "(.)"}}}
	r, e = d.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if r.Rows.Rows[0]["id"] != "d" {
		t.Fatal(r)
	}
}

func TestV2DatetimeErrorsRemainLazy(t *testing.T) {
	db, d := setupV2(t)
	if _, e := db.Exec("UPDATE runs SET stamp='bad timestamp' WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	q := metricV2("MIN([stamp])")
	m := runMetric(t, db, d, q)
	if m.Buckets[0].Error != "datetime_invalid" || m.Buckets[0].Value != nil {
		t.Fatal(m)
	}
	q = metricV2("IF(FALSE,MIN([stamp]),NULL)")
	m = runMetric(t, db, d, q)
	if m.Buckets[0].Error != "" || m.Buckets[0].Value != nil {
		t.Fatal(m)
	}
}

func TestV2FrontendWireContract(t *testing.T) {
	db, d := setupV2(t)
	ctx := context.Background()
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	def := qt.ComputedColumn{ID: "bad", Label: "Bad", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]/0"}}
	if _, e := store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: def}); e != nil {
		t.Fatal(e)
	}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, ExpectedRevisions: map[string]string{"bad": "1"}, WireQuery: qt.WireQuery{Select: []string{"id", "@computed/bad"}, Limit: 2}}
	m := metricV2("SUM([n])/0")
	m.Limit = 2
	m.ExpectedRevisions = q.ExpectedRevisions
	result, e := d.ExecuteV2(ctx, db, &q, &m, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	fixture := struct {
		RowRequest   qt.ServerQueryV2          `json:"rowRequest"`
		RowResult    *qt.SQLiteRowsV2Result    `json:"rowResult"`
		MetricResult *qt.SQLiteMetricsV2Result `json:"metricResult"`
	}{q, result.Rows, result.Metrics}
	body, e := json.Marshal(fixture)
	if e != nil {
		t.Fatal(e)
	}
	var decoded map[string]any
	if e = json.Unmarshal(body, &decoded); e != nil {
		t.Fatal(e)
	}
	rows := decoded["rowResult"].(map[string]any)
	sidecar := rows["computed"].([]any)[0].(map[string]any)["values"].(map[string]any)
	value := sidecar["bad"].(map[string]any)
	if value["value"] != nil || value["error"].(map[string]any)["code"] != "divide_by_zero" {
		t.Fatal(value)
	}
	metrics := decoded["metricResult"].(map[string]any)["metrics"].([]any)[0].(map[string]any)
	bucket := metrics["buckets"].([]any)[0].(map[string]any)
	if bucket["error"] != "divide_by_zero" || bucket["value"] != nil {
		t.Fatal(bucket)
	}
	// Also usable by the frontend validator during cross-language integration QA.
	t.Logf("FRONTEND_FIXTURE %s", body)
}
