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

func setupV2(t *testing.T) (*sql.DB, qt.QueryDatasetV3) {
	return setup(t)
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
	q.Result.Limit = 2
	q.Result.Offset = 1
	q.Result.OrderBy = []qt.OrderBy{{Field: "n", Dir: "desc"}}
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
					q := rowsV3(qt.WireQuery{Select: []string{"id"}, OrderBy: order, Limit: 2})
					_, err = dataset.Execute(context.Background(), db, q, qt.PlanOptions{})
				} else {
					q := metricV2("COUNT()")
					q.Result.OrderBy = order
					q.Result.Limit = 2
					q.Metrics[0].Scope = "shownRows"
					_, err = dataset.Execute(context.Background(), db, q, qt.PlanOptions{})
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
	q.Result.Where = []qt.WhereTerm{{Field: "n", Op: ">", Value: "1000"}}
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
	description, e := d.DescribeComputedPartialIn(context.Background(), tx, []string{"twice", "neg"}, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	execution := description.Execution
	q := v3Request(qt.WireQuery{Select: []string{"id", "tags", "stamp", "@computed/twice"}, OrderBy: []qt.OrderBy{{Field: "@computed/neg", Dir: "desc"}}, Limit: 2}, true, qt.AggSpec{ID: "m", Expression: "SUM([@computed/twice])"})
	q.ExpectedRevisions = execution.ResolvedRevisions
	r, e := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	// v3 returns computed values inline in rows instead of a Computed sidecar.
	if r.Total != 4 || r.Rows[0]["id"] != "a" || r.Rows[0]["@computed/twice"] != float64(-4) || r.Metrics[0].Buckets[0].Value != float64(-24) {
		t.Fatal(r)
	}
	q.Metrics = nil
	q.ExpectedRevisions = map[string]string{"twice": "1", "neg": "stale"}
	if _, e = d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{}); e == nil {
		t.Fatal("accepted stale dependency")
	}
}
func TestV2ValidationAndBudgets(t *testing.T) {
	db, d := setupV2(t)
	for _, change := range []func(*qt.QueryRequestV3){func(q *qt.QueryRequestV3) { q.Profile = qt.ServerExpressionProfile }, func(q *qt.QueryRequestV3) { q.Diagnostics = []string{"residual"} }, func(q *qt.QueryRequestV3) { q.PlanToken = "unvalidated" }, func(q *qt.QueryRequestV3) { q.Snapshot = "unbound" }} {
		q := metricV2("SUM([n])")
		change(&q)
		if _, e := d.Execute(context.Background(), db, q, qt.PlanOptions{}); e == nil {
			t.Fatal("invalid query accepted", q)
		}
	}
	// An invalid clause fails only its own metric.
	for _, change := range []func(*qt.QueryRequestV3){func(q *qt.QueryRequestV3) {
		q.Metrics[0].Distribution = &qt.MetricDistribution{Kind: "unknown", Input: "[n]"}
	}, func(q *qt.QueryRequestV3) { q.Metrics[0].Expression = "SUM(SUM([n]))" }, func(q *qt.QueryRequestV3) { q.Metrics[0].Expression = "SUM([n])+[n]" }} {
		q := metricV2("SUM([n])")
		change(&q)
		r, e := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		metricFailure(t, r, e)
	}
	d.MaxPopulation = 3
	q := metricV2("COUNT()")
	// v3 applies MaxPopulation only to staged execution; ungrouped metrics
	// read SourceSQL directly, so the budget binds only the staged path.
	var diag *qt.PlanDiagnostic
	if _, e := qt.TestOnlyStageUngrouped(d).Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(e, &diag) || diag.Code != "resource_limit" {
		t.Fatal("population budget ignored", e)
	}
	if m := runMetric(t, db, d, q); m.Buckets[0].Value != float64(4) {
		t.Fatal("direct metrics applied the staging budget", m)
	}
	d.MaxPopulation = 0
	d.MaxGroups = 2
	q.Metrics[0].GroupBy = []string{"flag"}
	q.Metrics[0].GroupLimit = 1
	if r, e := d.Execute(context.Background(), db, q, qt.PlanOptions{}); metricFailure(t, r, e) != "group population exceeds host budget" {
		t.Fatal("group budget ignored before topN")
	}
	d.MaxGroups = 0
	q = metricV2("COUNT()")
	q.Result.Where = []qt.WhereTerm{{Field: "text", Op: "matches_regex", Value: "(?i)^école"}}
	m := runMetric(t, db, d, q)
	if m.Buckets[0].Value != float64(2) {
		t.Fatal(m)
	}
	// v3 capabilities have no Distributions flag: distributions always execute.
	if caps := d.Capabilities(); caps.Version != 3 || caps.Profile != qt.SQLiteExpressionProfile {
		t.Fatal(caps)
	}
}

func TestV2HostGroupBudget(t *testing.T) {
	db, d := setupV2(t)
	q := v3Request(qt.WireQuery{Select: []string{"id"}, Limit: 1, Offset: 1}, true, qt.AggSpec{ID: "m", Expression: "COUNT()", GroupBy: []string{"flag"}, GroupLimit: 1}, qt.AggSpec{ID: "count", Expression: "COUNT()"})
	for _, budget := range []int{0, 10_000, 100_000, 100_001, -1} {
		d.MaxGroups = budget
		r, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
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
		if len(r.Rows) != 1 || r.Total != 4 || len(r.Metrics) != 2 {
			t.Fatalf("budget %d: result=%#v", budget, r)
		}
		m := r.Metrics[0]
		if m.Error != "" || m.GroupCount != 3 || len(m.Buckets) != 1 || r.Metrics[1].Buckets[0].Value != float64(4) {
			t.Fatalf("budget %d: metrics=%#v", budget, r.Metrics)
		}
	}
	// Neither top-N nor row paging may hide groups from the host budget.
	d.MaxGroups = 2
	r, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatalf("metric group budget failed the request: %v", err)
	}
	m, sibling := r.Metrics[0], r.Metrics[1]
	if m.Error != "group population exceeds host budget" || len(m.Buckets) != 0 || sibling.Error != "" || sibling.Buckets[0].Value != float64(4) || len(r.Rows) != 1 || r.Total != 4 {
		t.Fatalf("group budget isolation: rows=%#v metrics=%#v", r.Rows, r.Metrics)
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
	// v3 checks the MaxSamplesPerGroup budget (default 100000) before reducing
	// and fails the metric, where v2 reported resource_limit on its bucket.
	r, e := d.Execute(context.Background(), db, metricV2("MEDIAN([n])"), qt.PlanOptions{})
	if m := metricFailure(t, r, e); m != "MEDIAN exceeded the 100,000-sample budget" {
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
	handshake, e := d.DescribeComputedPartialIn(ctx, tx, []string{"unused"}, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	q := v3Request(qt.WireQuery{Select: []string{"id", "n"}, Limit: 4}, true, qt.AggSpec{ID: "m", Expression: "SUM([n])"})
	q.ExpectedRevisions, q.PlanToken, q.Snapshot = handshake.Execution.ResolvedRevisions, "valid", "held"
	o := qt.PlanOptions{ValidatePlanToken: func(context.Context, string) error { return nil }, ValidateSnapshot: func(context.Context, string) error { return nil }}
	if _, e = db.Exec("UPDATE runs SET n=20 WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	revision := "1"
	def.Expression.Source = "[n]+2"
	if _, e = store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: def, ExpectedRevision: &revision}); e != nil {
		t.Fatal(e)
	}
	r, e := d.ExecuteIn(ctx, tx, q, o)
	if e != nil {
		t.Fatal(e)
	}
	// v3 rows carry JSON numbers (float64). Its execution lists capabilities of
	// projected computed fields only; the handshake carries the unused one.
	if r.Metrics[0].Buckets[0].Value != float64(12) || r.Rows[0]["n"] != float64(2) || r.Execution.ResolvedRevisions["unused"] != "1" || handshake.Execution.Fields["@computed/unused"].Type != "number" || r.Execution.PlanToken != "valid" || r.Execution.Snapshot != "held" {
		t.Fatal(r)
	}
	q.Snapshot = ""
	q.PlanToken = ""
	q.Metrics = nil
	if _, e = d.Execute(ctx, db, q, qt.PlanOptions{}); e == nil {
		t.Fatal("stale unused handshake revision accepted")
	}
}
func TestV2AlternateAndRegexSorting(t *testing.T) {
	db, d := setupV2(t)
	f := d.Schema.Fields["text"]
	f.SortExpr = "r.stamp"
	f.SQLiteSortField = "stamp"
	d.Schema.Fields["text"] = f
	q := rowsV3(qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "text", Dir: "desc"}}, Limit: 2})
	r := executeV3(t, db, d, q, qt.PlanOptions{})
	if r.Rows[0]["id"] != "d" || r.Rows[1]["id"] != "a" {
		t.Fatal(r)
	}
	q.Result.OrderBy = []qt.OrderBy{{Field: "id", Dir: "desc", Extract: &qt.RegexExtract{Regex: "(.)"}}}
	r = executeV3(t, db, d, q, qt.PlanOptions{})
	if r.Rows[0]["id"] != "d" {
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
	q := v3Request(qt.WireQuery{Select: []string{"id", "@computed/bad"}, Limit: 2}, true, qt.AggSpec{ID: "m", Expression: "SUM([n])/0"})
	q.ExpectedRevisions = map[string]string{"bad": "1"}
	result := executeV3(t, db, d, q, qt.PlanOptions{})
	fixture := struct {
		Request qt.QueryRequestV3 `json:"request"`
		Result  qt.QueryResultV3  `json:"result"`
	}{q, result}
	body, e := json.Marshal(fixture)
	if e != nil {
		t.Fatal(e)
	}
	var decoded map[string]any
	if e = json.Unmarshal(body, &decoded); e != nil {
		t.Fatal(e)
	}
	out := decoded["result"].(map[string]any)
	// v3 writes a computed cell error inline instead of in a Computed sidecar.
	value := out["rows"].([]any)[0].(map[string]any)["@computed/bad"].(map[string]any)
	if len(value) != 1 || value["computedError"] != "divide_by_zero" {
		t.Fatal(value)
	}
	metrics := out["metrics"].([]any)[0].(map[string]any)
	bucket := metrics["buckets"].([]any)[0].(map[string]any)
	if bucket["error"] != "divide_by_zero" || bucket["value"] != nil {
		t.Fatal(bucket)
	}
	// Also usable by the frontend validator during cross-language integration QA.
	t.Logf("FRONTEND_FIXTURE %s", body)
}
