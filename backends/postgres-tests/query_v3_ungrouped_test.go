package postgrestests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// ungroupedV3 creates rows deterministic rows in a disposable schema. The
// source is schema-qualified so statement-hooked connections can read it.
func ungroupedV3(t testing.TB, rows int) (*sql.DB, qt.QueryDatasetV3, qt.PlanOptions) {
	t.Helper()
	dsn := os.Getenv("QT_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("set QT_TEST_POSTGRES to a disposable PostgreSQL database")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("qt_direct_%x", time.Now().UnixNano())
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
	t.Cleanup(func() { db.Close(); _, _ = admin.Exec("DROP SCHEMA " + name + " CASCADE"); admin.Close() })
	if _, err = db.Exec(fmt.Sprintf(`CREATE TABLE direct(id text PRIMARY KEY,tenant text,k text,e text,n double precision,m bigint,at timestamptz,flag boolean,tags text[],note text);
INSERT INTO direct SELECT 'r'||lpad(i::text,7,'0'),(ARRAY['one','one','one','two'])[i%%4+1],(ARRAY['alpha','beta','gamma','',NULL,'Delta'])[i%%6+1],(ARRAY['low','mid','high'])[i%%3+1],
 CASE WHEN i%%11=0 THEN NULL ELSE i%%17-3 END,i%%5,CASE WHEN i%%11=0 THEN NULL ELSE timestamptz '2026-10-01T00:00:00Z'+((i%%40)||' days')::interval+((i%%24)||' hours')::interval END,
 CASE WHEN i%%11=0 THEN NULL ELSE i%%2=1 END,CASE i%%5 WHEN 0 THEN ARRAY['red','blue'] WHEN 2 THEN '{}'::text[] WHEN 3 THEN ARRAY['green'] WHEN 4 THEN ARRAY['red'] END,(ARRAY['red fox','blue whale',NULL,'Red panda','école','x🙂y',''])[i%%7+1]
FROM generate_series(0,%d) AS i;
ANALYZE direct`, rows-1)); err != nil {
		t.Fatal(err)
	}
	yes := true
	fields := map[string]qt.FieldSpec{
		"id": {Kind: qt.FieldText}, "k": {Kind: qt.FieldText, Groupable: &yes}, "e": {Kind: qt.FieldEnum, Groupable: &yes},
		"n": {Kind: qt.FieldNumber, Groupable: &yes}, "m": {Kind: qt.FieldNumber, Groupable: &yes}, "at": {Kind: qt.FieldDatetime, Groupable: &yes},
		"flag": {Kind: qt.FieldBool, Groupable: &yes}, "tags": {Kind: qt.FieldTextArray}, "note": {Kind: qt.FieldText},
	}
	for field, f := range fields {
		f.Name, f.Expr, f.Sortable, f.ServerFilter, f.ExpressionNumeric = field, "r."+field, f.Kind != qt.FieldTextArray, true, true
		fields[field] = f
	}
	definitions := map[string]string{"double": "[n]*2", "inv": "1/([m]-1)", "big": "IF([n]>5,TRUE,FALSE)"}
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		source, ok := definitions[id]
		if !ok {
			return qt.ComputedColumn{}, &qt.PlanDiagnostic{Code: "definition_missing", Message: "missing " + id}
		}
		return qt.ComputedColumn{ID: id, Label: id, Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: source}}, nil
	})}
	return db, qt.QueryDatasetV3{Schema: qt.Schema{Name: "direct", IDField: "id", Fields: fields, TiebreakSort: []qt.OrderBy{{Field: "k", Dir: "asc", Nulls: "last"}}}, SourceSQL: "SELECT * FROM " + name + ".direct WHERE tenant=$1", SourceArgs: []any{"one"}, Dialect: "postgres", Scope: "one", Dataset: "direct", ComputedFilterable: map[string]bool{"double": true, "big": true}, ComputedGroupable: map[string]bool{"big": true}}, o
}
func ungroupedRequest(result qt.WireQuery, metrics ...qt.AggSpec) qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).UnixMilli(), Rows: true, ExpectedRevisions: map[string]string{"double": "1", "inv": "1", "big": "1"}, Source: qt.WireQuery{Limit: 1}, Result: result, Metrics: metrics}
}
func executeV3In(db *sql.DB, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) (string, error) {
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	out, err := d.ExecuteIn(context.Background(), tx, q, o)
	if err != nil {
		return "", err
	}
	var leaked int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM pg_class WHERE relpersistence='t' AND relname LIKE 'qt_%'`).Scan(&leaked); err != nil || leaked != 0 {
		return "", fmt.Errorf("leaked %d scratch tables: %v", leaked, err)
	}
	data, err := json.Marshal(out)
	return string(data), err
}
func ungroupedCases() map[string]qt.QueryRequestV3 {
	page := func(where []qt.WhereTerm, order ...qt.OrderBy) qt.WireQuery {
		return qt.WireQuery{Select: []string{"id", "k", "e", "n", "at", "flag", "tags", "note"}, Where: where, OrderBy: order, Limit: 25, Offset: 3}
	}
	byK := []string{"k"}
	cases := map[string]qt.QueryRequestV3{
		"default projection":          ungroupedRequest(qt.WireQuery{Limit: 40}),
		"sorted window":               ungroupedRequest(page(nil, qt.OrderBy{Field: "n", Dir: "desc", Nulls: "first"}, qt.OrderBy{Field: "at", Dir: "asc"})),
		"text sort and filter":        ungroupedRequest(page([]qt.WhereTerm{{Field: "note", Op: "contains", Value: "RED"}, {Field: "n", Op: ">", Value: "0"}}, qt.OrderBy{Field: "note", Dir: "asc", Nulls: "last"})),
		"or of ands":                  ungroupedRequest(page([]qt.WhereTerm{{Any: []qt.WhereClause{{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "alpha"}, {Field: "e", Op: "=", Value: "low"}}}, {All: []qt.WhereClause{{Field: "k", Op: "=", Value: "beta"}, {Field: "flag", Op: "=", Value: "true"}}}}}})),
		"arrays":                      ungroupedRequest(page([]qt.WhereTerm{{Field: "tags", Op: "includes", Value: "red"}})),
		"nulls and negation":          ungroupedRequest(page([]qt.WhereTerm{{Field: "k", Op: "is_null"}, {Field: "note", Op: "contains", Value: "o", Negated: true}})),
		"datetime filter":             ungroupedRequest(page([]qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-20T00:00:00Z"}})),
		"computed select sort filter": ungroupedRequest(qt.WireQuery{Select: []string{"id", "@computed/double", "@computed/inv", "@computed/big"}, Where: []qt.WhereTerm{{Field: "@computed/double", Op: ">", Value: "2"}}, OrderBy: qt.OrderBys{{Field: "@computed/inv", Dir: "desc", Nulls: "last"}}, Limit: 30}),
		"empty": ungroupedRequest(page([]qt.WhereTerm{{Field: "k", Op: "=", Value: "missing"}}),
			qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "sum", Op: "sum", Field: "n", GroupBy: byK}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])"}, qt.AggSpec{ID: "shown", Op: "count", Scope: "shownRows"}),
		"metrics": ungroupedRequest(page([]qt.WhereTerm{{Field: "m", Op: "!=", Value: "4"}}, qt.OrderBy{Field: "n", Dir: "asc"}),
			qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "sum", Op: "sum", Field: "n"}, qt.AggSpec{ID: "avg", Op: "avg", Field: "n", GroupBy: byK},
			qt.AggSpec{ID: "distinct", Op: "count_distinct", Field: "k"}, qt.AggSpec{ID: "min", Op: "min", Field: "at", GroupBy: []string{"e", "flag"}}, qt.AggSpec{ID: "max", Op: "max", Field: "at"},
			qt.AggSpec{ID: "formula", Expression: "SUM([n])/COUNT()", GroupBy: []string{"e"}}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])", GroupBy: byK},
			qt.AggSpec{ID: "shown", Op: "sum", Field: "n", Scope: "shownRows", GroupBy: byK}, qt.AggSpec{ID: "where", Op: "count", GroupBy: byK, Where: []qt.WhereTerm{{Field: "flag", Op: "=", Value: "true"}}},
			qt.AggSpec{ID: "min_count", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 40}}, qt.AggSpec{ID: "min_sum", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 100, Sum: "m"}}, qt.AggSpec{ID: "min_distinct", Op: "count", GroupBy: byK, MinCount: qt.MetricMinCount{Min: 3, Distinct: "e"}},
			qt.AggSpec{ID: "top", Op: "sum", Field: "m", GroupBy: byK, Sort: []qt.MetricSort{{Key: "value", Dir: "desc"}}, GroupLimit: 2},
			qt.AggSpec{ID: "box", Op: "count", GroupBy: []string{"e"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}}, qt.AggSpec{ID: "histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n]", Bins: 6}},
			qt.AggSpec{ID: "scatter", Expression: "SUM([n])", ExpressionY: "COUNT()", GroupBy: byK},
			qt.AggSpec{ID: "computed", Op: "sum", Field: "@computed/double", GroupBy: []string{"@computed/big"}}, qt.AggSpec{ID: "computed_error", Op: "sum", Field: "@computed/inv"},
			qt.AggSpec{ID: "invalid", Op: "sum", Field: "note"}),
		"calendar": ungroupedRequest(qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-05T00:00:00Z"}}, OrderBy: qt.OrderBys{{Field: "at", Dir: "desc"}}, Limit: 15},
			qt.AggSpec{ID: "weeks", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "week", TimeZone: "America/New_York", Range: "query"}},
			qt.AggSpec{ID: "hours", Op: "sum", Field: "n", GroupBy: []string{"at", "k"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "hourOfDay", TimeZone: "UTC", Range: "observed"}},
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

func TestPostgresUngroupedDirectMatchesStaged(t *testing.T) {
	db, d, o := ungroupedV3(t, 400)
	staged := qt.StageUngroupedForTesting(d)
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

func TestPostgresUngroupedDirectEnvelopeAndBudgets(t *testing.T) {
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
	staged := qt.StageUngroupedForTesting(d)
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
	budgets := []struct {
		name   string
		modify func(*qt.QueryDatasetV3)
		q      qt.QueryRequestV3
	}{
		{"rows", func(d *qt.QueryDatasetV3) { d.MaxRows = 10 }, ungroupedRequest(qt.WireQuery{Limit: 11})},
		{"groups", func(d *qt.QueryDatasetV3) { d.MaxGroups = 3 }, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "ok", Op: "count", GroupBy: []string{"e"}}, qt.AggSpec{ID: "wide", Op: "count", GroupBy: []string{"id"}}, qt.AggSpec{ID: "calendar", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}})},
		{"samples", func(d *qt.QueryDatasetV3) { d.MaxSamplesPerGroup = 20 }, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "median", Expression: "MEDIAN([n])"}, qt.AggSpec{ID: "grouped", Expression: "MEDIAN([n])", GroupBy: []string{"e", "k"}}, qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}}, qt.AggSpec{ID: "count", Op: "count"})},
		{"regex", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Where: []qt.WhereTerm{{Field: "note", Op: "matches_regex", Value: "^red"}}, Limit: 5})},
		{"duplicate metric", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Limit: 5}, qt.AggSpec{ID: "a", Op: "count"}, qt.AggSpec{ID: "a", Op: "count"})},
		{"unknown field", func(*qt.QueryDatasetV3) {}, ungroupedRequest(qt.WireQuery{Select: []string{"secret"}, Limit: 5})},
	}
	for _, c := range budgets {
		t.Run(c.name, func(t *testing.T) {
			limited := d
			c.modify(&limited)
			want, wantErr := executeV3In(db, qt.StageUngroupedForTesting(limited), c.q, o)
			got, gotErr := executeV3In(db, limited, c.q, o)
			if got != want || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
				t.Fatalf("direct %s err=%v\nstaged %s err=%v", got, gotErr, want, wantErr)
			}
			if wantErr == nil && !strings.Contains(got, `"error":"`) {
				t.Fatalf("budget did not fail a metric: %s", got)
			}
		})
	}
	limited := d
	limited.MaxPopulation, limited.MaxStagingBytes = 1, 1
	q = ungroupedCases()["metrics"]
	if _, err = executeV3In(db, qt.StageUngroupedForTesting(limited), q, o); !errors.As(err, &diag) || diag.Code != "resource_limit" {
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

// largeUngrouped is a 360,000-row source whose 270,000 'one' rows exceed the
// default 250,000-row population budget, read through a statement log.
func largeUngrouped(tb testing.TB) (*sql.DB, *statementLog, qt.QueryDatasetV3, qt.PlanOptions, qt.QueryRequestV3) {
	original, d, o := ungroupedV3(tb, 360000)
	log := &statementLog{}
	db := sql.OpenDB(statementHookConnector{base: original.Driver(), hook: log.hook})
	tb.Cleanup(func() { db.Close() })
	q := ungroupedRequest(qt.WireQuery{Select: []string{"id", "k", "n", "at", "@computed/double"}, OrderBy: qt.OrderBys{{Field: "at", Dir: "desc", Nulls: "last"}}, Limit: 100, Offset: 500},
		qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "sum", Op: "sum", Field: "n", GroupBy: []string{"k"}}, qt.AggSpec{ID: "shown", Op: "avg", Field: "@computed/double", Scope: "shownRows"})
	return db, log, d, o, q
}

func TestPostgresLargeUngroupedPageDoesNotStage(t *testing.T) {
	if testing.Short() {
		t.Skip("large fixture")
	}
	db, log, d, o, q := largeUngrouped(t)
	var diag *qt.PlanDiagnostic
	if _, err := executeV3In(db, qt.StageUngroupedForTesting(d), q, o); !errors.As(err, &diag) || diag.Message != "matching population exceeds host budget" {
		t.Fatalf("staged execution must exceed the default population budget: %v", err)
	}
	log.reset(nil)
	out, err := executeV3In(db, d, q, o)
	if err != nil {
		t.Fatal(err)
	}
	var result qt.QueryResultV3
	if err = json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 270000 || result.SourceTotal != 270000 || len(result.Rows) != 100 || result.Metrics[0].Buckets[0].Count != 270000 || result.Metrics[2].ProcessedRows != 100 {
		t.Fatalf("total=%d rows=%d metrics=%v", result.Total, len(result.Rows), result.Metrics)
	}
	// No statement copies the population: no temporary table, CTAS or COPY.
	log.mu.Lock()
	defer log.mu.Unlock()
	for _, statement := range log.seen {
		upper := strings.ToUpper(statement)
		if strings.Contains(upper, "CREATE ") || strings.Contains(upper, " INTO ") || strings.Contains(upper, "COPY ") {
			t.Fatalf("direct execution staged: %s", statement)
		}
	}
	if len(log.seen) < 4 {
		t.Fatalf("statement log: %q", log.seen)
	}
}

// BenchmarkPostgresLargeUngroupedPage pages, counts and reduces the large
// source directly. QT_BENCH_STAGED=1 measures the staged path instead, with
// budgets raised so it can copy the 270,000 matching rows.
func BenchmarkPostgresLargeUngroupedPage(b *testing.B) {
	db, _, d, o, q := largeUngrouped(b)
	if os.Getenv("QT_BENCH_STAGED") != "" {
		d.MaxPopulation, d.MaxStagingBytes = 1000000, 1<<30
		d = qt.StageUngroupedForTesting(d)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := executeV3In(db, d, q, o); err != nil {
			b.Fatal(err)
		}
	}
}
