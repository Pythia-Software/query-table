package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"modernc.org/sqlite"
)

// sqliteCalls counts scalar function invocations by name, so tests can assert
// how often guards and decoders run without timing anything.
var sqliteCalls = map[string]*atomic.Int64{}

func init() {
	for _, f := range append(qt.SQLiteFunctions(), qt.SQLiteV2Functions()...) {
		f := f
		calls := &atomic.Int64{}
		sqliteCalls[f.Name] = calls
		if e := sqlite.RegisterDeterministicScalarFunction(f.Name, int32(f.Arity), func(_ *sqlite.FunctionContext, a []driver.Value) (driver.Value, error) {
			calls.Add(1)
			return f.Call(a)
		}); e != nil {
			panic(e)
		}
	}
	for _, f := range qt.SQLiteV2Aggregates() {
		f := f
		if e := sqlite.RegisterFunction(f.Name, &sqlite.FunctionImpl{NArgs: int32(f.Arity), Deterministic: true, MakeAggregate: func(sqlite.FunctionContext) (sqlite.AggregateFunction, error) {
			return &aggregateBridge{fn: f.New()}, nil
		}}); e != nil {
			panic(e)
		}
	}
}

type aggregateBridge struct{ fn qt.SQLiteAggregateFunction }

func (a *aggregateBridge) Step(_ *sqlite.FunctionContext, v []driver.Value) error {
	return a.fn.Step(v)
}
func (a *aggregateBridge) WindowValue(_ *sqlite.FunctionContext) (driver.Value, error) {
	return a.fn.Value()
}
func (a *aggregateBridge) WindowInverse(_ *sqlite.FunctionContext, _ []driver.Value) error {
	return errors.New("sliding windows unsupported")
}
func (a *aggregateBridge) Final(_ *sqlite.FunctionContext) { a.fn = nil }

const runsDDL = `CREATE TABLE runs(id TEXT PRIMARY KEY, tenant TEXT, text TEXT COLLATE NOCASE,n ANY,tags TEXT,stamp TEXT,flag INTEGER) STRICT;
 INSERT INTO runs VALUES
 ('a','one','ÉCOLE 100%_x',2,'["RED","école"]','2026-01-01T00:00:00+02:00',1),
 ('b','one','école',4,'[]','2025-12-31T22:00:00Z',0),
 ('c','one','',NULL,NULL,NULL,NULL),
 ('d','one',NULL,6,'["red"]','2026-01-01T00:00:00Z',1),
 ('e','two','secret',100,'["secret"]','2027-01-01T00:00:00Z',0)`

func setup(t *testing.T) (*sql.DB, qt.QueryDatasetV3) {
	t.Helper()
	db, e := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "test.db"))+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(4)
	t.Cleanup(func() { db.Close() })
	_, e = db.Exec(runsDDL)
	if e != nil {
		t.Fatal(e)
	}
	fields := map[string]qt.FieldSpec{}
	for name, kind := range map[string]qt.FieldKind{"id": qt.FieldText, "text": qt.FieldText, "n": qt.FieldNumber, "tags": qt.FieldTextArray, "stamp": qt.FieldDatetime, "flag": qt.FieldBool} {
		fields[name] = qt.FieldSpec{Name: name, Kind: kind, Expr: "r." + name, SortExpr: "r." + name, ServerFilter: true, Sortable: true}
	}
	// v3 numeric filters and metrics require the bounded-arithmetic opt-in.
	n := fields["n"]
	n.ExpressionNumeric = true
	fields["n"] = n
	d := sqliteV3(qt.Schema{Name: "runs", IDField: "id", Fields: fields}, "SELECT * FROM runs WHERE tenant=?1", []any{"one"}, "one", "runs")
	return db, d
}

// rowsV1 pages every matching row, as the removed v1 Rows did with no limit.
func rowsV1(ctx context.Context, db *sql.DB, d qt.QueryDatasetV3, w qt.WireQuery) (qt.QueryResultV3, error) {
	if w.Limit == 0 {
		w.Limit = 100
	}
	return d.Execute(ctx, db, rowsV3(w), qt.PlanOptions{})
}
func TestFilters(t *testing.T) {
	db, d := setup(t)
	for _, c := range []struct {
		field, op, value string
		neg              bool
		want             []string
	}{
		{"text", "contains", "ÉCOLE", false, []string{"a", "b"}}, {"text", "contains", "%_", false, []string{"a"}},
		{"text", "starts_with", "éco", false, []string{"a", "b"}}, {"text", "ends_with", "ÉCOLE", false, []string{"b"}},
		{"text", "is_null", "", false, []string{"c", "d"}}, {"text", "is_not_null", "", false, []string{"a", "b"}},
		{"text", "contains", "école", true, []string{}}, {"text", "=", "", false, []string{"c", "d"}},
		{"text", "!=", "école", false, []string{"a", "c", "d"}},
		{"text", "matches_regex", "(?i)^école", false, []string{"a", "b"}}, {"text", "not_matches_regex", "(?i)^école", false, []string{"c"}},
		{"text", "length_eq", "5", false, []string{"b"}},
		{"tags", "includes", "red", false, []string{"a", "d"}}, {"tags", "includes", "RED", true, []string{}},
		{"tags", "is_null", "", false, []string{"b", "c"}}, {"tags", "is_not_null", "", false, []string{"a", "d"}},
		{"n", ">", "2", false, []string{"b", "d"}}, {"flag", "=", "true", false, []string{"a", "d"}},
		{"stamp", "=", "2025-12-31T22:00:00Z", false, []string{"a", "b"}},
	} {
		t.Run(c.field+c.op+c.value, func(t *testing.T) {
			r, e := rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: c.field, Op: c.op, Value: c.value, Negated: c.neg}}})
			if e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(ids(r), c.want) {
				t.Fatalf("got %v want %v", ids(r), c.want)
			}
		})
	}
	f := d.Schema.Fields["tags"]
	f.ArrayCaseSensitive = true
	d.Schema.Fields["tags"] = f
	r, e := rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "tags", Op: "includes", Value: "RED"}}})
	if e != nil || !reflect.DeepEqual(ids(r), []string{"a"}) {
		t.Fatalf("exact arrays: %v %v", ids(r), e)
	}
}
func TestSortingAndPaging(t *testing.T) {
	db, d := setup(t)
	d.Schema.DefaultSort = []qt.OrderBy{{Field: "stamp", Dir: "asc"}}
	r, e := rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"text"}, Limit: 2, Offset: 1})
	if e != nil {
		t.Fatal(e)
	}
	if r.Total != 4 || !reflect.DeepEqual(ids(r), []string{"b", "d"}) {
		t.Fatal(r)
	}
	// v3 projects only dependencies for an empty select; v1 projected every field.
	all, e := rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"id", "text", "n", "tags", "stamp", "flag"}})
	if e != nil {
		t.Fatal(e)
	}
	// v3 writes datetimes with millisecond precision.
	if all.Rows[0]["flag"] != true || all.Rows[0]["stamp"] != "2025-12-31T22:00:00.000Z" {
		t.Fatal(all.Rows[0])
	}
	r, e = rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "text", Dir: "asc", Nulls: "first", Extract: &qt.RegexExtract{Regex: "(?i)(école)"}}}})
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(ids(r)[:2], []string{"c", "d"}) {
		t.Fatal(r)
	}
}
func TestScopeDistinctAndStatistics(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	distinct := func(field, search string, limit int) *qt.DistinctResultV3 {
		t.Helper()
		r, e := d.Execute(ctx, db, distinctV3(field, search, limit), qt.PlanOptions{})
		if e != nil {
			t.Fatal(e)
		}
		return r.Distinct
	}
	got := distinct("tags", "ÉCO", 1)
	if !reflect.DeepEqual(got.Values, []string{"école"}) || !got.HasNull {
		t.Fatal(got)
	}
	got = distinct("text", "", 1)
	if !got.HasMore || !got.HasNull || got.Values[0] != "" {
		t.Fatal(got)
	}
	// v1 FieldStats is v3 count_distinct/min/max metrics per field.
	stats := map[string]qt.MetricResult{}
	q := metricsV3(nil, nil, 0, 0)
	for _, field := range []string{"n", "stamp", "text"} {
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: field + ":distinct", Op: "count_distinct", Field: field}, qt.AggSpec{ID: field + ":max", Op: "max", Field: field})
	}
	for _, m := range executeV3(t, db, d, q, qt.PlanOptions{}).Metrics {
		stats[m.ID] = m
	}
	// v3 metric values are JSON numbers (float64); v1 returned SQLite integers.
	if stats["n:distinct"].Buckets[0].Value != float64(3) || stats["n:max"].Buckets[0].Value != float64(6) || stats["stamp:distinct"].Buckets[0].Value != float64(2) {
		t.Fatal(stats)
	}
}
func TestAggregatesAndRefusals(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	request := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "sum", Op: "sum", Field: "n"}, qt.AggSpec{ID: "avg", Op: "avg", Field: "n"}, qt.AggSpec{ID: "count", Op: "count"}, qt.AggSpec{ID: "groups", Op: "count", GroupBy: []string{"flag"}})
	r := executeV3(t, db, d, request, qt.PlanOptions{})
	// v3 metric values are JSON numbers (float64); v1 returned SQLite integers.
	if r.Metrics[0].Buckets[0].Value != float64(12) || r.Metrics[1].Buckets[0].Value != float64(4) || r.Metrics[2].Buckets[0].Count != 4 {
		t.Fatal(r)
	}
	request.Result.Where = []qt.WhereTerm{{Field: "n", Op: ">", Value: "999"}}
	r = executeV3(t, db, d, request, qt.PlanOptions{})
	if r.Metrics[0].Buckets[0].Value != nil || r.Metrics[2].Buckets[0].Value != float64(0) || len(r.Metrics[3].Buckets) != 0 {
		t.Fatal(r)
	}
	request.Result.Where = nil
	d.MaxGroups = 1
	// v3 isolates the group budget to the grouped metric instead of failing the request.
	r, e := d.Execute(ctx, db, request, qt.PlanOptions{})
	if e != nil || r.Metrics[3].Error == "" || len(r.Metrics[3].Buckets) != 0 || r.Metrics[2].Error != "" {
		t.Fatal("silently truncated groups", r, e)
	}
	d.MaxGroups = 0
	for _, value := range []any{int64(9007199254740992), "not numeric", float64(1e100)} {
		if _, e = db.Exec("UPDATE runs SET n=? WHERE id='a'", value); e != nil {
			t.Fatal(e)
		}
		// v3 reports an unsafe stored value on the bucket instead of failing the request.
		m := runMetric(t, db, d, metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "s", Op: "sum", Field: "n"}))
		if m.Error == "" && (len(m.Buckets) != 1 || m.Buckets[0].Error == "" || m.Buckets[0].Value != nil) {
			t.Fatal("accepted unsafe value", value, m)
		}
	}
}
func TestPinnedSnapshotAndCancellation(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	tx, e := db.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	page := rowsV3(qt.WireQuery{Select: []string{"id"}, Limit: 100})
	before, e := d.ExecuteIn(ctx, tx, page, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec("INSERT INTO runs VALUES ('f','one','new',1,'[]',NULL,0)"); e != nil {
		t.Fatal(e)
	}
	after, e := d.ExecuteIn(ctx, tx, page, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if after.Total != before.Total {
		t.Fatal("snapshot changed")
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	fresh, e := rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id"}})
	if e != nil || fresh.Total != 5 {
		t.Fatal(fresh, e)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, e = rowsV1(canceled, db, d, qt.WireQuery{}); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
func TestComputedStoreAtomicRevisionAndScope(t *testing.T) {
	db, _ := setup(t)
	ctx := context.Background()
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	column := qt.ComputedColumn{ID: "x", Label: "X", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1+2"}}
	saved, e := store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: column})
	if e != nil || saved.Revision != "1" {
		t.Fatal(saved, e)
	}
	revision := saved.Revision
	var wg sync.WaitGroup
	out := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: column, ExpectedRevision: &revision})
			out <- e
		}()
	}
	wg.Wait()
	close(out)
	conflicts, successes := 0, 0
	for e := range out {
		if errors.Is(e, qt.ErrComputedConflict) {
			conflicts++
		} else if e == nil {
			successes++
		} else {
			t.Fatal(e)
		}
	}
	if conflicts != 1 || successes != 1 {
		t.Fatal(conflicts, successes)
	}
	list, e := store.List(ctx, "two", "runs")
	if e != nil || len(list) != 0 {
		t.Fatal(list, e)
	}
	if _, e = store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: column}); !errors.Is(e, qt.ErrComputedConflict) {
		t.Fatal(e)
	}
}
func TestInjectionAndBadStorage(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	r, e := rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "text", Op: "contains", Value: "' OR 1=1 --"}}})
	if e != nil || len(r.Rows) != 0 {
		t.Fatal(r, e)
	}
	if _, e = rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id; DROP TABLE runs"}}); e == nil {
		t.Fatal("untrusted column accepted")
	}
	if _, e = db.Exec("UPDATE runs SET tags='broken' WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	r, e = rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "tags", Op: "is_null"}}})
	if e != nil || !reflect.DeepEqual(ids(r), []string{"a", "b", "c"}) {
		t.Fatal(r, e)
	}
	// v3 projects only dependencies for an empty select, so select the array.
	if _, e = rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id", "tags"}}); e == nil || !strings.Contains(e.Error(), "textarray") {
		t.Fatal(e)
	}
}

func TestDatetimeStorageModesAndPrecision(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	if _, e := db.Exec(`CREATE TABLE times(id TEXT PRIMARY KEY,stamp TEXT,ms INTEGER,seconds REAL) STRICT;
 INSERT INTO times VALUES ('a','2026-01-01T00:00:00.000Z',1767225600000,1767225600),('b','2026-01-01T00:00:00.001Z',1767225600001,1767225600.001)`); e != nil {
		t.Fatal(e)
	}
	d.SourceSQL = "SELECT * FROM times"
	d.SourceArgs = nil
	d.Schema.Fields = map[string]qt.FieldSpec{"id": {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true}, "stamp": {Name: "stamp", Kind: qt.FieldDatetime, Expr: "r.stamp", Sortable: true, ServerFilter: true, SQLiteDatetimeFormat: "utc-millis"}}
	for _, test := range []struct {
		op   string
		want []string
	}{{"=", []string{}}, {"!=", []string{"a", "b"}}, {">", []string{"b"}}, {">=", []string{"b"}}, {"<", []string{"a"}}, {"<=", []string{"a"}}} {
		r, e := rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "stamp", Op: test.op, Value: "2026-01-01T00:00:00.0005Z"}}})
		if e != nil {
			t.Fatal(e)
		}
		if !reflect.DeepEqual(ids(r), test.want) {
			t.Fatalf("%s got %v want %v", test.op, ids(r), test.want)
		}
	}
	for _, format := range []string{"unix-millis", "unix-seconds"} {
		f := d.Schema.Fields["stamp"]
		f.SQLiteDatetimeFormat = format
		f.Expr = "r.ms"
		if format == "unix-seconds" {
			f.Expr = "r.seconds"
		}
		d.Schema.Fields["stamp"] = f
		r, e := rowsV1(ctx, db, d, qt.WireQuery{Select: []string{"id", "stamp"}})
		if e != nil {
			t.Fatal(e)
		}
		// v3 writes datetimes with millisecond precision.
		if r.Rows[0]["stamp"] != "2026-01-01T00:00:00.000Z" {
			t.Fatal(r)
		}
		if format == "unix-millis" && r.Rows[1]["stamp"] != "2026-01-01T00:00:00.001Z" {
			t.Fatal(r.Rows[1])
		}
		choices, e := d.Execute(ctx, db, distinctV3("stamp", "2026-01-01", 50), qt.PlanOptions{})
		if e != nil || len(choices.Distinct.Values) != 2 {
			t.Fatal(choices, e)
		}
	}
}
func TestSetFilterCompositions(t *testing.T) {
	db, d := setup(t)
	if _, e := db.Exec(`CREATE TABLE sets(id TEXT,tags TEXT);INSERT INTO sets VALUES ('empty','[]'),('a','["a"]'),('b','["b"]'),('ab','["a","b"]'),('c','["c"]'),('missing',NULL)`); e != nil {
		t.Fatal(e)
	}
	d.SourceSQL = "SELECT * FROM sets"
	d.SourceArgs = nil
	d.Schema.Fields = map[string]qt.FieldSpec{"id": {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true}, "tags": {Name: "tags", Kind: qt.FieldTextArray, Expr: "r.tags", ServerFilter: true}}
	include := func(value string, neg bool) qt.WhereClause {
		return qt.WhereClause{Field: "tags", Op: "includes", Value: value, Negated: neg}
	}
	empty := qt.WhereClause{Field: "tags", Op: "is_null"}
	cases := []struct {
		name  string
		where []qt.WhereTerm
		want  []string
	}{
		{"any", []qt.WhereTerm{{Any: []qt.WhereClause{include("a", false), include("b", false)}}}, []string{"a", "ab", "b"}},
		{"all", []qt.WhereTerm{{Field: "tags", Op: "includes", Value: "a"}, {Field: "tags", Op: "includes", Value: "b"}}, []string{"ab"}},
		{"none", []qt.WhereTerm{{Any: []qt.WhereClause{empty, include("a", true)}}, {Any: []qt.WhereClause{empty, include("b", true)}}}, []string{"c", "empty", "missing"}},
	}
	for _, c := range cases {
		r, e := rowsV1(context.Background(), db, d, qt.WireQuery{Select: []string{"id"}, Where: c.where})
		if e != nil || !reflect.DeepEqual(ids(r), c.want) {
			t.Fatal(c.name, r, e)
		}
	}
}
func TestIdentityAndCollationGuards(t *testing.T) {
	db, d := setup(t)
	ctx := context.Background()
	if _, e := db.Exec(`UPDATE runs SET text='ASCII' WHERE id='a';UPDATE runs SET text='ascii' WHERE id='b'`); e != nil {
		t.Fatal(e)
	}
	result, e := d.Execute(ctx, db, metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "distinct", Op: "count_distinct", Field: "text"}), qt.PlanOptions{})
	// v3 metric values are JSON numbers (float64); v1 returned SQLite integers.
	if e != nil || result.Metrics[0].Buckets[0].Value != float64(3) {
		t.Fatal(result, e)
	}
	// v3 pages ungrouped rows without an identity check; representative rows
	// (grouped ROW summaries) are where it rejects duplicate identities.
	d.SourceSQL = "SELECT runs.* FROM runs CROSS JOIN (SELECT 1 UNION ALL SELECT 2) duplicate WHERE tenant=?1"
	q := rowsV3(qt.WireQuery{Limit: 10})
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"flag"}, Summaries: []qt.SummaryColumn{{ID: "example", Op: "row", Field: "id"}}, Representative: &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}}}
	q.Source.Limit = 1
	if _, e := d.Execute(ctx, db, q, qt.PlanOptions{}); e == nil || !strings.Contains(e.Error(), "duplicate") {
		t.Fatal(e)
	}
}
