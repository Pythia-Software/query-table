package querytable

import (
	"context"
	"database/sql/driver"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sqliteTestSchema() Schema {
	fields := map[string]FieldSpec{}
	for name, kind := range map[string]FieldKind{"id": FieldText, "text": FieldText, "n": FieldNumber, "tags": FieldTextArray, "when": FieldDatetime, "bool": FieldBool} {
		fields[name] = FieldSpec{Name: name, Kind: kind, Expr: "r." + name, SortExpr: "r." + name, ServerFilter: true, Sortable: true}
	}
	return Schema{Name: "test", IDField: "id", Fields: fields}
}

// compileTestSQLiteRows compiles a SQLite row page as v3 executes it.
func compileTestSQLiteRows(q WireQuery, s Schema) (SQLPlan, error) {
	return compileComputedRowsDialect(context.Background(), q, s, PlanOptions{SourceSQL: "SELECT * FROM fixture"}, true)
}

func TestSQLiteCompilerGuards(t *testing.T) {
	s := sqliteTestSchema()
	bad := []WireQuery{
		{Where: []WhereTerm{{Field: "missing", Op: "=", Value: "x"}}},
		{Where: []WhereTerm{{Field: "n", Op: "contains", Value: "x"}}},
		{Where: []WhereTerm{{Field: "n", Op: "=", Value: "NaN"}}},
		{Where: []WhereTerm{{Field: "n", Op: "=", Value: "Inf"}}},
		{Where: []WhereTerm{{Field: "text", Op: "matches_regex", Value: "(?<=x)y"}}},
		{Where: []WhereTerm{{Field: "text", Op: "length_eq", Value: "01"}}},
		{Where: []WhereTerm{{Any: []WhereClause{}}}},
		{Where: []WhereTerm{{Field: "text", Any: []WhereClause{{Field: "text", Op: "=", Value: "x"}}}}},
		{OrderBy: []OrderBy{{Field: "text", Dir: "oops"}}},
		{OrderBy: []OrderBy{{Field: "text", Dir: "asc", Nulls: "oops"}}},
		{OrderBy: []OrderBy{{Field: "text", Dir: "asc", Extract: &RegexExtract{Regex: "["}}}},
		{Select: []string{"@computed/x"}},
	}
	for _, q := range bad {
		if len(q.Select) == 0 {
			q.Select = []string{"id"} // A page needs a projection.
		}
		q.Limit = 1
		if _, e := compileTestSQLiteRows(q, s); e == nil {
			t.Errorf("accepted %#v", q)
		}
	}
	if _, e := compileTestSQLiteRows(WireQuery{Select: []string{"id"}, Limit: 1}, s); e != nil {
		t.Fatal(e)
	}
	f := s.Fields["text"]
	f.FilterOps = []string{"="}
	s.Fields["text"] = f
	if _, e := compileTestSQLiteRows(WireQuery{Select: []string{"id"}, Limit: 1, Where: []WhereTerm{{Field: "text", Op: "contains", Value: "x"}}}, s); e == nil {
		t.Fatal("ignored filter policy")
	}
}
func TestSQLiteCompilerComposition(t *testing.T) {
	s := sqliteTestSchema()
	s.DefaultSort = []OrderBy{{Field: "text", Dir: "asc", Extract: &RegexExtract{Regex: "(x)"}}}
	payload := "' OR 1=1; DROP TABLE runs; --"
	q := WireQuery{Where: []WhereTerm{{Field: "text", Op: "ends_with", Value: payload}}, Select: []string{"id"}}
	where, e := compileSQLiteWhereV1(q.Where, s, sqliteOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(where.SQL, payload) || !reflect.DeepEqual(where.Args, []any{payload}) {
		t.Fatalf("unsafe fragment: %#v", where)
	}
	// The page binds the filter, then the default sort's regex, then the window.
	page, e := compileTestSQLiteRows(WireQuery{Select: q.Select, Where: q.Where, Limit: 1}, s)
	if e != nil || strings.Contains(page.SQL, payload) || !reflect.DeepEqual(page.Args, []any{payload, "(x)", 1, 0}) {
		t.Fatalf("unsafe or misordered page: %v %v", page, e)
	}
	if !strings.Contains(page.SQL, "r.id AS f1") || !strings.HasSuffix(page.SQL, "f1 COLLATE BINARY ASC NULLS LAST") {
		t.Fatal(page.SQL)
	}
	q.Where = []WhereTerm{{Any: []WhereClause{{Field: "text", Op: "contains", Value: ""}, {Field: "n", Op: ">", Value: "12"}}}}
	where, e = compileSQLiteWhereV1(q.Where, s, sqliteOptions{})
	if e != nil || where.SQL != "" || len(where.Args) != 0 {
		t.Fatalf("OR clear input: %#v %v", where, e)
	}
	q.Where[0].Any[1].Field = "missing"
	if _, e = compileSQLiteWhereV1(q.Where, s, sqliteOptions{}); e == nil {
		t.Fatal("skipped OR validation")
	}
	// An OR of AND branches; a blank literal drops out of its branch, and a
	// branch with nothing left makes the group a no-op.
	q.Where = []WhereTerm{{Any: []WhereClause{
		{All: []WhereClause{{Field: "text", Op: "=", Value: "a"}, {Field: "n", Op: ">", Value: "1"}}},
		{All: []WhereClause{{Field: "text", Op: "=", Value: "b"}, {Field: "text", Op: "contains", Value: ""}}},
	}}}
	where, e = compileSQLiteWhereV1(q.Where, s, sqliteOptions{})
	if e != nil || !strings.HasPrefix(where.SQL, "((") || strings.Count(where.SQL, " AND ") != 1 || strings.Count(where.SQL, " OR ") != 1 || len(where.Args) != 3 {
		t.Fatalf("OR of ANDs: %#v %v", where, e)
	}
	q.Where[0].Any[1].All = []WhereClause{{Field: "text", Op: "contains", Value: ""}}
	if where, e = compileSQLiteWhereV1(q.Where, s, sqliteOptions{}); e != nil || where.SQL != "" {
		t.Fatalf("always-true branch: %#v %v", where, e)
	}
	q.Where[0].Any[1].All = []WhereClause{{Field: "missing", Op: "=", Value: "x"}}
	if _, e = compileSQLiteWhereV1(q.Where, s, sqliteOptions{}); e == nil {
		t.Fatal("skipped branch validation")
	}
}
func TestSQLiteSchemaDialect(t *testing.T) {
	doc := []byte(`{"name":"s","idField":"id","fields":[{"name":"id","type":"text","bindings":{"postgres":{"expr":"pg.id"},"sqlite":{"expr":"s.id"}}},{"name":"date","type":"datetime","bindings":{"sqlite":{"expr":"s.date","datetimeFormat":"utc-millis"}}}]}`)
	s, e := LoadSQLiteSchema(doc)
	if e != nil {
		t.Fatal(e)
	}
	if s.Fields["id"].Expr != "s.id" || s.Fields["date"].SQLiteDatetimeFormat != "utc-millis" {
		t.Fatal(s)
	}
	if _, e = LoadSQLiteSchema([]byte(schemaJSON)); e == nil {
		t.Fatal("fell back to Postgres")
	}
}
func TestSQLiteRelativeDatetime(t *testing.T) {
	s := sqliteTestSchema()
	now := time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.UTC)
	c, e := compileSQLiteWhereV1([]WhereTerm{{Field: "when", Op: ">", Value: "-1d"}}, s, sqliteOptions{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	if c.Args[0] != "2026-01-01T03:04:05.123456789Z" {
		t.Fatal(c.Args)
	}
}
func TestSQLiteScalarFunctions(t *testing.T) {
	functions := map[string]SQLiteScalarFunction{}
	for _, f := range SQLiteFunctions() {
		functions[f.Name] = f
	}
	for _, test := range []struct {
		name string
		args []driver.Value
		want driver.Value
	}{
		{"qt_lower", []driver.Value{"ÉCOLE"}, "école"}, {"qt_length", []driver.Value{"a\x00😀"}, int64(3)},
		{"qt_regexp_extract", []driver.Value{"(x*)", "a"}, ""}, {"qt_regexp_extract", []driver.Value{"(x)?a", "a"}, nil},
		{"qt_regexp", []driver.Value{"x", nil}, nil}, {"qt_array_json", []driver.Value{`{"x":"y"}`}, "[]"},
		{"qt_array_json", []driver.Value{`[null]`}, "[]"}, {"qt_datetime", []driver.Value{"2026-01-01T00:00:00+02:00"}, "2025-12-31T22:00:00.000000000Z"},
	} {
		v, e := functions[test.name].Call(test.args)
		if e != nil || !reflect.DeepEqual(v, test.want) {
			t.Errorf("%s = %#v, %v", test.name, v, e)
		}
	}
	if _, e := functions["qt_regexp"].Call([]driver.Value{"[", "x"}); e == nil {
		t.Fatal("invalid regex accepted")
	}
	if _, e := functions["qt_number"].Call([]driver.Value{int64(9007199254740992)}); e == nil {
		t.Fatal("unsafe integer accepted")
	}
}

func TestSQLiteAlternateSortUsesTargetStorage(t *testing.T) {
	for _, test := range []struct{ kind, format, want string }{
		{"datetime", "unix-millis", "ORDER BY v2 ASC NULLS LAST,f0 COLLATE BINARY ASC NULLS LAST"},
		{"datetime", "rfc3339", "ORDER BY v2 ASC NULLS LAST,f0 COLLATE BINARY ASC NULLS LAST"},
		// Canonical UTC text sorts as stored.
		{"datetime", "utc-millis", "ORDER BY f2 COLLATE BINARY ASC NULLS LAST,f0 COLLATE BINARY ASC NULLS LAST"},
		{"number", "", "ORDER BY v1 ASC NULLS LAST,f0 COLLATE BINARY ASC NULLS LAST"},
	} {
		doc := `{"name":"s","idField":"id","fields":[{"name":"id","type":"text","bindings":{"sqlite":{"expr":"r.id"}}},{"name":"label","type":"text","sort":{"field":"timestamp"},"bindings":{"sqlite":{"expr":"r.label"}}},{"name":"timestamp","type":"` + test.kind + `","bindings":{"sqlite":{"expr":"r.timestamp","datetimeFormat":"` + test.format + `"}}}]}`
		schema, err := LoadSQLiteSchema([]byte(doc))
		if err != nil {
			t.Fatal(err)
		}
		f := schema.Fields["timestamp"]
		f.ExpressionNumeric = test.kind == "number" // v3 sorts typed numeric values.
		schema.Fields["timestamp"] = f
		p, err := compileTestSQLiteRows(WireQuery{Select: []string{"id"}, OrderBy: []OrderBy{{Field: "label", Dir: "asc"}}, Limit: 1}, schema)
		if err != nil {
			t.Fatal(test, err)
		}
		// The label sorts by the timestamp binding (f2), read in its own storage format.
		if !strings.Contains(p.SQL, "r.timestamp AS f2") || !strings.Contains(p.SQL, test.want) {
			t.Fatal(test, p.SQL)
		}
		if test.kind == "datetime" && test.format != "utc-millis" && (!strings.Contains(p.SQL, "qt_v2_datetime(f2,?1) AS v1") || p.Args[0] != test.format) {
			t.Fatal(test, p.SQL, p.Args)
		}
	}
}

func TestSQLiteSelectedArraysRequireArrayStorage(t *testing.T) {
	for _, value := range []string{"null", "{}", "[null]", "1", "broken"} {
		if _, err := sqliteOutput(value, FieldSpec{Kind: FieldTextArray}); err == nil {
			t.Fatalf("accepted %q as a selected array", value)
		}
	}
	if value, err := sqliteOutput("[]", FieldSpec{Kind: FieldTextArray}); err != nil || !reflect.DeepEqual(value, []string{}) {
		t.Fatal(value, err)
	}
}
