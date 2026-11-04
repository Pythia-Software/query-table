package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func ungroupedV3(t *testing.T, rows int) (*sql.DB, qt.QueryDatasetV3, qt.PlanOptions) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "direct.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(`CREATE TABLE direct(id TEXT PRIMARY KEY,tenant TEXT,k TEXT,e TEXT,n REAL,m INTEGER,at TEXT,secs INTEGER,flag INTEGER,tags TEXT,note TEXT)`); err != nil {
		t.Fatal(err)
	}
	keys := []any{"alpha", "beta", "gamma", "", nil, "Delta"}
	notes := []any{"red fox", "blue whale", nil, "Red panda", "école", "x🙂y", ""}
	tags := []any{`["red","blue"]`, `[]`, nil, `["green"]`, `["red"]`}
	for i := 0; i < rows; i++ {
		var n, at, secs, flag any = float64(i%17) - 3, time.Date(2026, 10, 1+i%40, i%24, 0, 0, 0, time.UTC).Format("2006-01-02T15:04:05.000Z"), int64(1790000000 + 3600*i), int64(i % 2)
		if i%11 == 0 {
			n, at, secs, flag = nil, nil, nil, nil
		}
		if _, err = db.Exec("INSERT INTO direct VALUES(?,?,?,?,?,?,?,?,?,?,?)", fmt.Sprintf("r%04d", i), []string{"one", "one", "one", "two"}[i%4], keys[i%len(keys)], []string{"low", "mid", "high"}[i%3], n, int64(i%5), at, secs, flag, tags[i%len(tags)], notes[i%len(notes)]); err != nil {
			t.Fatal(err)
		}
	}
	yes := true
	fields := map[string]qt.FieldSpec{
		"id":   {Kind: qt.FieldText},
		"k":    {Kind: qt.FieldText, Groupable: &yes},
		"e":    {Kind: qt.FieldEnum, Groupable: &yes},
		"n":    {Kind: qt.FieldNumber, Groupable: &yes},
		"m":    {Kind: qt.FieldNumber, Groupable: &yes},
		"at":   {Kind: qt.FieldDatetime, SQLiteDatetimeFormat: "utc-millis", Groupable: &yes},
		"secs": {Kind: qt.FieldDatetime, SQLiteDatetimeFormat: "unix-seconds", Groupable: &yes},
		"flag": {Kind: qt.FieldBool, Groupable: &yes},
		"tags": {Kind: qt.FieldTextArray},
		"note": {Kind: qt.FieldText},
	}
	for name, f := range fields {
		f.Name, f.Expr, f.Sortable, f.ServerFilter, f.ExpressionNumeric = name, "r."+name, f.Kind != qt.FieldTextArray, true, true
		fields[name] = f
	}
	definitions := map[string]string{"double": "[n]*2", "inv": "1/([m]-1)", "big": "IF([n]>5,TRUE,FALSE)"}
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		source, ok := definitions[id]
		if !ok {
			return qt.ComputedColumn{}, &qt.PlanDiagnostic{Code: "definition_missing", Message: "missing " + id}
		}
		return qt.ComputedColumn{ID: id, Label: id, Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: source}}, nil
	})}
	return db, qt.QueryDatasetV3{Schema: qt.Schema{Name: "direct", IDField: "id", Fields: fields, TiebreakSort: []qt.OrderBy{{Field: "k", Dir: "asc", Nulls: "last"}}}, SourceSQL: "SELECT * FROM direct WHERE tenant=?1", SourceArgs: []any{"one"}, Dialect: "sqlite", Scope: "one", Dataset: "direct", ComputedFilterable: map[string]bool{"double": true, "big": true}, ComputedGroupable: map[string]bool{"big": true}}, o
}
func ungroupedRequest(result qt.WireQuery, metrics ...qt.AggSpec) qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).UnixMilli(), Rows: true, ExpectedRevisions: map[string]string{"double": "1", "inv": "1", "big": "1"}, Source: qt.WireQuery{Limit: 1}, Result: result, Metrics: metrics}
}
func executeV3In(db *sql.DB, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) (string, error) {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	out, err := d.ExecuteIn(context.Background(), tx, q, o)
	if err != nil {
		return "", err
	}
	var leaked int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM sqlite_temp_master WHERE name LIKE 'qt_%'`).Scan(&leaked); err != nil || leaked != 0 {
		return "", fmt.Errorf("leaked %d scratch tables: %v", leaked, err)
	}
	data, err := json.Marshal(out)
	return string(data), err
}
func ungroupedCases() map[string]qt.QueryRequestV3 {
	page := func(where []qt.WhereTerm, order ...qt.OrderBy) qt.WireQuery {
		return qt.WireQuery{Select: []string{"id", "k", "e", "n", "at", "secs", "flag", "tags", "note"}, Where: where, OrderBy: order, Limit: 25, Offset: 3}
	}
	byK := []string{"k"}
	cases := map[string]qt.QueryRequestV3{
		"default projection":          ungroupedRequest(qt.WireQuery{Limit: 40}),
		"sorted window":               ungroupedRequest(page(nil, qt.OrderBy{Field: "n", Dir: "desc", Nulls: "first"}, qt.OrderBy{Field: "secs", Dir: "asc"})),
		"text sort and filter":        ungroupedRequest(page([]qt.WhereTerm{{Field: "note", Op: "contains", Value: "RED"}, {Field: "n", Op: ">", Value: "0"}}, qt.OrderBy{Field: "note", Dir: "asc", Nulls: "last"})),
		"or of ands":                  ungroupedRequest(page([]qt.WhereTerm{{Any: []qt.WhereClause{{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "alpha"}, {Field: "e", Op: "=", Value: "low"}}}, {All: []qt.WhereClause{{Field: "k", Op: "=", Value: "beta"}, {Field: "flag", Op: "=", Value: "true"}}}}}})),
		"regex and arrays":            ungroupedRequest(page([]qt.WhereTerm{{Field: "note", Op: "matches_regex", Value: "(?i)^red"}, {Field: "tags", Op: "includes", Value: "red"}})),
		"nulls and negation":          ungroupedRequest(page([]qt.WhereTerm{{Field: "k", Op: "is_null"}, {Field: "note", Op: "contains", Value: "o", Negated: true}})),
		"datetime filter":             ungroupedRequest(page([]qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-20T00:00:00Z"}, {Field: "secs", Op: "<", Value: "2026-10-01T00:00:00Z"}})),
		"computed select sort filter": ungroupedRequest(qt.WireQuery{Select: []string{"id", "@computed/double", "@computed/inv", "@computed/big"}, Where: []qt.WhereTerm{{Field: "@computed/double", Op: ">", Value: "2"}}, OrderBy: []qt.OrderBy{{Field: "@computed/inv", Dir: "desc", Nulls: "last"}}, Limit: 30}),
		// The stored-field distribution scan cannot read a computed filter; it
		// declines to the compiled plans instead of failing the request.
		"distributions over a computed filter": ungroupedRequest(page([]qt.WhereTerm{{Field: "@computed/double", Op: ">", Value: "10"}}),
			qt.AggSpec{ID: "box", Op: "count", GroupBy: []string{"e"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
			qt.AggSpec{ID: "histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n]", Bins: 6}}),
		"empty": ungroupedRequest(page([]qt.WhereTerm{{Field: "k", Op: "=", Value: "missing"}}),
			qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "sum", Op: "sum", Field: "n", GroupBy: byK}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])"}, qt.AggSpec{ID: "shown", Op: "count", Scope: "shownRows"}),
		"metrics": ungroupedRequest(page([]qt.WhereTerm{{Field: "m", Op: "!=", Value: "4"}}, qt.OrderBy{Field: "n", Dir: "asc"}),
			qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "sum", Op: "sum", Field: "n"}, qt.AggSpec{ID: "avg", Op: "avg", Field: "n", GroupBy: byK},
			qt.AggSpec{ID: "distinct", Op: "count_distinct", Field: "k"}, qt.AggSpec{ID: "min", Op: "min", Field: "at", GroupBy: []string{"e", "flag"}}, qt.AggSpec{ID: "max", Op: "max", Field: "secs"},
			qt.AggSpec{ID: "formula", Expression: "SUM([n])/COUNT()", GroupBy: []string{"e"}}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])", GroupBy: byK},
			qt.AggSpec{ID: "shown", Op: "sum", Field: "n", Scope: "shownRows", GroupBy: byK}, qt.AggSpec{ID: "where", Op: "count", GroupBy: byK, Where: []qt.WhereTerm{{Field: "flag", Op: "=", Value: "true"}}},
			qt.AggSpec{ID: "min_count", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 40}}, qt.AggSpec{ID: "min_sum", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 100, Sum: "m"}}, qt.AggSpec{ID: "min_distinct", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 3, Distinct: "e"}},
			qt.AggSpec{ID: "top", Op: "sum", Field: "m", GroupBy: byK, Sort: []qt.MetricSort{{Key: "value", Dir: "desc"}}, GroupLimit: 2},
			qt.AggSpec{ID: "box", Op: "count", GroupBy: []string{"e"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}}, qt.AggSpec{ID: "histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n]", Bins: 6}},
			qt.AggSpec{ID: "scatter", Expression: "SUM([n])", ExpressionY: "COUNT()", GroupBy: byK},
			qt.AggSpec{ID: "computed", Op: "sum", Field: "@computed/double", GroupBy: []string{"@computed/big"}}, qt.AggSpec{ID: "computed_error", Op: "sum", Field: "@computed/inv"},
			qt.AggSpec{ID: "invalid", Op: "sum", Field: "note"}),
		"calendar": ungroupedRequest(qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-05T00:00:00Z"}}, OrderBy: []qt.OrderBy{{Field: "at", Dir: "desc"}}, Limit: 15},
			qt.AggSpec{ID: "days", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "week", TimeZone: "America/New_York", Range: "query"}},
			qt.AggSpec{ID: "hours", Op: "sum", Field: "n", GroupBy: []string{"secs", "k"}, DateGrouping: &qt.MetricDateGrouping{Field: "secs", Interval: "hourOfDay", TimeZone: "UTC", Range: "observed"}},
			qt.AggSpec{ID: "shown_days", Op: "count", Scope: "shownRows", GroupBy: []string{"at"}, MinCount: qt.MetricMinCount{Min: 2}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}},
			qt.AggSpec{ID: "count", Op: "count"}),
	}
	metricsOnly := cases["metrics"]
	metricsOnly.Rows = false
	cases["metrics only"] = metricsOnly
	host := cases["sorted window"]
	host.HostState = json.RawMessage(`{"tenant":"one","flags":[1,2]}`)
	cases["host state"] = host
	return cases
}

func TestV3UngroupedDirectMatchesStaged(t *testing.T) {
	db, d, o := ungroupedV3(t, 400)
	staged := qt.TestOnlyStageUngrouped(d)
	for name, q := range ungroupedCases() {
		t.Run(name, func(t *testing.T) {
			want, err := executeV3In(db, staged, q, o)
			if err != nil {
				t.Fatal(err)
			}
			got, err := executeV3In(db, d, q, o)
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Fatalf("direct:\n%s\nstaged:\n%s", got, want)
			}
			if name == "metrics" && !strings.Contains(got, `"error":"`) {
				t.Fatal("expected an isolated metric failure", got)
			}
		})
	}
}

func TestV3UngroupedDirectEnvelopeAndBudgets(t *testing.T) {
	db, d, o := ungroupedV3(t, 120)
	q := ungroupedCases()["computed select sort filter"]
	q.PlanToken, q.Snapshot = "signed-plan", "retained-data"
	q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "@computed/double"}, {ID: "median", Expression: "MEDIAN([n])"}}
	tokens, snapshots := 0, 0
	o.ValidatePlanToken = func(_ context.Context, token string) error {
		tokens++
		if token != "signed-plan" {
			return &qt.PlanDiagnostic{Code: "plan_token_invalid", Message: "bad token"}
		}
		return nil
	}
	o.ValidateSnapshot = func(context.Context, string) error { snapshots++; return nil }
	staged := qt.TestOnlyStageUngrouped(d)
	want, err := executeV3In(db, staged, q, o)
	if err != nil {
		t.Fatal(err)
	}
	tokens, snapshots = 0, 0
	got, err := executeV3In(db, d, q, o)
	if err != nil || got != want {
		t.Fatalf("direct %s err=%v\nstaged %s", got, err, want)
	}
	if tokens != 1 || snapshots != 1 || !strings.Contains(got, `"planToken":"signed-plan"`) || !strings.Contains(got, `"snapshot":"retained-data"`) || !strings.Contains(got, `"resolvedRevisions":{"big":"1","double":"1","inv":"1"}`) {
		t.Fatalf("envelope validated tokens=%d snapshots=%d: %s", tokens, snapshots, got)
	}
	q.PlanToken = "forged"
	if _, err = executeV3In(db, d, q, o); err == nil || !strings.Contains(err.Error(), "bad token") {
		t.Fatal("forged plan token", err)
	}
	q.PlanToken = "signed-plan"
	q.ExpectedRevisions = map[string]string{"double": "2", "inv": "1", "big": "1"}
	var diag *qt.PlanDiagnostic
	if _, err = executeV3In(db, d, q, o); !errors.As(err, &diag) || diag.Code != "definition_changed" {
		t.Fatal("stale revision", err)
	}
	// Request and metric budgets match staged execution.
	budgets := []struct {
		name   string
		modify func(*qt.QueryDatasetV3)
		q      qt.QueryRequestV3
	}{
		{"rows", func(d *qt.QueryDatasetV3) { d.MaxRows = 10 }, ungroupedRequest(qt.WireQuery{Limit: 11})},
		{"groups", func(d *qt.QueryDatasetV3) { d.MaxGroups = 3 }, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "ok", Op: "count", GroupBy: []string{"e"}}, qt.AggSpec{ID: "wide", Op: "count", GroupBy: []string{"id"}}, qt.AggSpec{ID: "calendar", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}})},
		{"samples", func(d *qt.QueryDatasetV3) { d.MaxSamplesPerGroup = 20 }, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])"}, qt.AggSpec{ID: "grouped", Expression: "MEDIAN([n])", GroupBy: []string{"e", "k"}}, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}}, qt.AggSpec{ID: "count", Op: "count"})},
		{"metric count", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Limit: 5}, make([]qt.AggSpec, 21)...)},
		{"duplicate metric", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "a", Op: "count"}, qt.AggSpec{ID: "a", Op: "count"})},
		{"unknown field", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Select: []string{"secret"}, Limit: 5})},
	}
	for _, c := range budgets {
		t.Run(c.name, func(t *testing.T) {
			limited := d
			c.modify(&limited)
			want, wantErr := executeV3In(db, qt.TestOnlyStageUngrouped(limited), c.q, o)
			got, gotErr := executeV3In(db, limited, c.q, o)
			if got != want || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
				t.Fatalf("direct %s err=%v\nstaged %s err=%v", got, gotErr, want, wantErr)
			}
			if wantErr == nil && !strings.Contains(got, `"error":"`) {
				t.Fatalf("budget did not fail a metric: %s", got)
			}
		})
	}
	// Direct pages copy nothing: population and staging budgets do not apply.
	limited := d
	limited.MaxPopulation, limited.MaxStagingBytes = 1, 1
	q = ungroupedCases()["metrics"]
	if _, err = executeV3In(db, qt.TestOnlyStageUngrouped(limited), q, o); !errors.As(err, &diag) || diag.Code != "resource_limit" {
		t.Fatal("staged budget", err)
	}
	want, err = executeV3In(db, staged, q, o)
	if err != nil {
		t.Fatal(err)
	}
	if got, err = executeV3In(db, limited, q, o); err != nil || got != want {
		t.Fatalf("direct ignored budgets: %s err=%v", got, err)
	}
}

func TestV3UngroupedInvalidStorageFailsThePage(t *testing.T) {
	db, d, o := ungroupedV3(t, 30)
	if _, err := db.Exec(`UPDATE direct SET n='oops' WHERE id='r0005'`); err != nil {
		t.Fatal(err)
	}
	var diag *qt.PlanDiagnostic
	page := ungroupedRequest(qt.WireQuery{Select: []string{"id", "n"}, OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}, Limit: 10})
	for _, dataset := range []qt.QueryDatasetV3{d, qt.TestOnlyStageUngrouped(d)} {
		if _, err := executeV3In(db, dataset, page, o); !errors.As(err, &diag) || diag.Code != "invalid_source_value" {
			t.Fatalf("invalid page value: %v", err)
		}
	}
	// Direct execution validates what it reads: a later page and metrics
	// report the invalid value per bucket, as v2 does, instead of failing.
	page.Result.Offset = 10
	page.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}}
	out, err := executeV3In(db, d, page, o)
	if err != nil || !strings.Contains(out, `"error":"storage_type"`) {
		t.Fatalf("later page: %s err=%v", out, err)
	}
}
