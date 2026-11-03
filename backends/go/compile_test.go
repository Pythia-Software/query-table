package querytable

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const schemaJSON = `{
  "name": "runs",
  "idField": "id",
  "tiebreakSort": [{"field": "id", "dir": "desc"}],
  "fields": [
    {"name": "id", "label": "ID", "type": "number", "bindings": {"postgres": {"expr": "r.id"}}},
    {"name": "case_name", "label": "Case", "type": "text", "bindings": {"postgres": {"expr": "r.case_name"}}},
    {"name": "restricted_name", "label": "Restricted", "type": "text", "filter": {"ops": ["="]},
      "bindings": {"postgres": {"expr": "r.restricted_name"}}},
    {"name": "overall", "label": "Overall", "type": "enum", "bindings": {"postgres": {"expr": "r.overall"}}},
    {"name": "total_ms", "label": "Total", "type": "number", "bindings": {"postgres": {"expr": "r.total_ms"}}},
    {"name": "is_starred", "label": "Star", "type": "bool", "sort": {"field": "is_starred"},
      "bindings": {"postgres": {"expr": "(w.tags ? 'x')", "synthetic": true}}},
    {"name": "function_names", "label": "Fns", "type": "textarray", "bindings": {"postgres": {"expr": "w.fn_names"}}},
    {"name": "error_codes", "label": "Errors", "type": "textarray", "filter": {"pushdown": false},
      "bindings": {"postgres": {"expr": "r.error_codes"}}},
    {"name": "details", "label": "D", "type": "text", "source": "derived"}
  ]
}`

func mustSchema(t *testing.T) Schema {
	t.Helper()
	s, err := LoadSchema([]byte(schemaJSON))
	if err != nil {
		t.Fatalf("LoadSchema: %v", err)
	}
	return s
}

func TestLoadSchema_skipsDerived(t *testing.T) {
	s := mustSchema(t)
	if _, ok := s.Fields["details"]; ok {
		t.Error("derived field should be absent from the backend schema")
	}
	if len(s.Fields) != 8 {
		t.Errorf("want 8 backend fields, got %d", len(s.Fields))
	}
	if s.Fields["error_codes"].ServerFilter {
		t.Error("error_codes has pushdown:false → ServerFilter should be false")
	}
	if !reflect.DeepEqual(s.Fields["restricted_name"].FilterOps, []string{"="}) {
		t.Errorf("restricted_name FilterOps = %#v", s.Fields["restricted_name"].FilterOps)
	}
}

func TestCompile_where(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereTerm{
		{Field: "overall", Op: "=", Value: "FAIL"},
		{Field: "total_ms", Op: ">", Value: "100"},
		{Field: "function_names", Op: "includes", Value: "SUM"},
	}}
	res, next, err := compileTestWhere(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "(r.overall = $1) AND (r.total_ms > $2) AND " +
		"(EXISTS (SELECT 1 FROM unnest(w.fn_names) AS _e WHERE LOWER(_e) = LOWER($3)))"
	if res.WhereSQL != want {
		t.Errorf("WhereSQL\n got: %s\nwant: %s", res.WhereSQL, want)
	}
	if next != 4 {
		t.Errorf("next idx = %d, want 4", next)
	}
	wantArgs := []any{"FAIL", float64(100), "SUM"}
	if !reflect.DeepEqual(res.Args, wantArgs) {
		t.Errorf("Args = %#v, want %#v", res.Args, wantArgs)
	}
}

func TestCompile_rejectsClientOnlyFilter(t *testing.T) {
	s := mustSchema(t)
	_, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "error_codes", Op: "includes", Value: "x"}}}, s, 1)
	if err == nil || !strings.Contains(err.Error(), "not server-filterable") {
		t.Errorf("want not-server-filterable error, got %v", err)
	}
}

func TestCompile_opMatrix(t *testing.T) {
	s := mustSchema(t)
	// '>' is invalid on an enum.
	if _, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "overall", Op: ">", Value: "x"}}}, s, 1); err == nil {
		t.Error("want error for '>' on enum")
	}
	// is_null is valid on bool (nullity on every type).
	res, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "is_starred", Op: "is_null", Value: ""}}}, s, 1)
	if err != nil || res.WhereSQL != "((w.tags ? 'x') IS NULL)" {
		t.Errorf("bool is_null: sql=%q err=%v", res.WhereSQL, err)
	}
}

func TestCompile_stringLength(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereTerm{
		{Field: "case_name", Op: "length_gt", Value: "5"},
		{Field: "case_name", Op: "length_lt", Value: "10"},
		{Field: "case_name", Op: "length_eq", Value: "0"},
	}}
	res, next, err := compileTestWhere(q, s, 2)
	if err != nil {
		t.Fatal(err)
	}
	if res.WhereSQL != "(CHAR_LENGTH(r.case_name) > $2::bigint) AND (CHAR_LENGTH(r.case_name) < $3::bigint) AND (CHAR_LENGTH(r.case_name) = $4::bigint)" {
		t.Errorf("unexpected SQL: %s", res.WhereSQL)
	}
	if !reflect.DeepEqual(res.Args, []any{int64(5), int64(10), int64(0)}) || next != 5 {
		t.Errorf("args = %#v, next = %d", res.Args, next)
	}
	large, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "case_name", Op: "length_lt", Value: "3000000000"}}}, s, 1)
	if err != nil || large.WhereSQL != "(CHAR_LENGTH(r.case_name) < $1::bigint)" || !reflect.DeepEqual(large.Args, []any{int64(3000000000)}) {
		t.Errorf("large length: result = %#v, err = %v", large, err)
	}
	for _, value := range []string{"-1", "1.5", "abc", "01"} {
		_, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "case_name", Op: "length_gt", Value: value}}}, s, 1)
		if err == nil {
			t.Errorf("accepted invalid length %q", value)
		}
	}
	_, _, err = compileTestWhere(WireQuery{Where: []WhereTerm{{Field: "overall", Op: "length_gt", Value: "2"}}}, s, 1)
	if err == nil {
		t.Error("length comparison should be text-only")
	}
}

func TestCompile_enforcesPerFieldOperatorOverride(t *testing.T) {
	s := mustSchema(t)
	_, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{
		Field: "restricted_name", Op: "matches_regex", Value: "^item-",
	}}}, s, 1)
	if err == nil || !strings.Contains(err.Error(), `op "matches_regex" is not enabled`) {
		t.Fatalf("want per-field operator rejection, got %v", err)
	}

	if _, _, err := compileTestWhere(WireQuery{Where: []WhereTerm{{
		Field: "restricted_name", Op: "=", Value: "item-1",
	}}}, s, 1); err != nil {
		t.Fatalf("configured operator should compile: %v", err)
	}
}

func TestCompile_orGroup(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereTerm{
		{Any: []WhereClause{{Field: "overall", Op: "=", Value: "PASS"}, {Field: "overall", Op: "=", Value: "FAIL"}}},
		{Field: "total_ms", Op: ">", Value: "100"},
	}}
	res, next, err := compileTestWhere(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "((r.overall = $1) OR (r.overall = $2)) AND (r.total_ms > $3)"
	if res.WhereSQL != want {
		t.Errorf("WhereSQL\n got: %s\nwant: %s", res.WhereSQL, want)
	}
	if next != 4 {
		t.Errorf("next idx = %d, want 4", next)
	}
	if !reflect.DeepEqual(res.Args, []any{"PASS", "FAIL", float64(100)}) {
		t.Errorf("Args = %#v", res.Args)
	}
}

func TestCompile_negatedLiteralIsNullExclusive(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereTerm{{Field: "case_name", Op: "contains", Value: "x", Negated: true}}}
	res, _, err := compileTestWhere(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "(NOT (POSITION(LOWER($1) IN LOWER(r.case_name)) > 0) AND r.case_name IS NOT NULL)"
	if res.WhereSQL != want {
		t.Errorf("WhereSQL\n got: %s\nwant: %s", res.WhereSQL, want)
	}
	if !reflect.DeepEqual(res.Args, []any{"x"}) {
		t.Errorf("Args = %#v", res.Args)
	}
}

func TestCompile_alwaysTrueDisjunctDropsGroup(t *testing.T) {
	s := mustSchema(t)
	// An empty-value "contains" is a no-op; ORed with anything the group is
	// always true and must emit no SQL (mirrors applyQuery).
	q := WireQuery{Where: []WhereTerm{
		{Any: []WhereClause{{Field: "case_name", Op: "contains", Value: ""}, {Field: "overall", Op: "=", Value: "PASS"}}},
	}}
	res, next, err := compileTestWhere(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if res.WhereSQL != "" {
		t.Errorf("WhereSQL = %q, want empty (group dropped)", res.WhereSQL)
	}
	if next != 1 || len(res.Args) != 0 {
		t.Errorf("next=%d args=%#v, want no placeholders consumed", next, res.Args)
	}
}

func TestCompile_orGroupValidatesEveryMember(t *testing.T) {
	s := mustSchema(t)
	// An unknown field inside a group is still reported even though the group
	// would otherwise be dropped for the empty-value member.
	q := WireQuery{Where: []WhereTerm{
		{Any: []WhereClause{{Field: "case_name", Op: "contains", Value: ""}, {Field: "nope", Op: "=", Value: "x"}}},
	}}
	if _, _, err := compileTestWhere(q, s, 1); err == nil || !strings.Contains(err.Error(), "unknown filter field") {
		t.Errorf("want unknown-field error, got %v", err)
	}
}

func TestCompile_orOfAnds(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereTerm{
		{Any: []WhereClause{
			{All: []WhereClause{{Field: "overall", Op: "=", Value: "PASS"}, {Field: "total_ms", Op: ">", Value: "100"}}},
			{All: []WhereClause{{Field: "overall", Op: "=", Value: "FAIL"}, {Field: "case_name", Op: "contains", Value: "x", Negated: true}}},
			{Field: "total_ms", Op: "<", Value: "5"},
		}},
	}}
	res, next, err := compileTestWhere(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "(((r.overall = $1) AND (r.total_ms > $2)) OR ((r.overall = $3) AND (NOT (POSITION(LOWER($4) IN LOWER(r.case_name)) > 0) AND r.case_name IS NOT NULL)) OR (r.total_ms < $5))"
	if res.WhereSQL != want {
		t.Errorf("WhereSQL\n got: %s\nwant: %s", res.WhereSQL, want)
	}
	if next != 6 || !reflect.DeepEqual(res.Args, []any{"PASS", float64(100), "FAIL", "x", float64(5)}) {
		t.Errorf("next=%d Args=%#v", next, res.Args)
	}
	// A blank literal drops out of its branch; a branch with nothing left is
	// always true, so the whole group is, after every literal is validated.
	q.Where[0].Any[0].All[1].Value = ""
	q.Where[0].Any[0].All[1].Op = "contains"
	q.Where[0].Any[0].All[1].Field = "case_name"
	if res, _, err = compileTestWhere(q, s, 1); err != nil || !strings.HasPrefix(res.WhereSQL, "(((r.overall = $1)) OR ((r.overall = $2) AND") {
		t.Errorf("blank literal: %q %v", res.WhereSQL, err)
	}
	q.Where[0].Any[0].All = []WhereClause{{Field: "case_name", Op: "contains", Value: ""}}
	if res, _, err = compileTestWhere(q, s, 1); err != nil || res.WhereSQL != "" {
		t.Errorf("always-true branch: %q %v", res.WhereSQL, err)
	}
	q.Where[0].Any[1].All[0].Field = "nope"
	if _, _, err = compileTestWhere(q, s, 1); err == nil || !strings.Contains(err.Error(), "unknown filter field") {
		t.Errorf("want unknown-field error, got %v", err)
	}
}

func TestValidate_orOfAndsShape(t *testing.T) {
	literal := WhereClause{Field: "overall", Op: "=", Value: "PASS"}
	for name, term := range map[string]WhereTerm{
		"empty branch":   {Any: []WhereClause{literal, {All: []WhereClause{}}}},
		"nested branch":  {Any: []WhereClause{literal, {All: []WhereClause{literal, {All: []WhereClause{literal}}}}}},
		"branch literal": {Any: []WhereClause{literal, {Field: "overall", All: []WhereClause{literal}}}},
	} {
		if err := (WireQuery{Where: []WhereTerm{term}}).Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
		if err := validateMetricSpecs([]AggSpec{{ID: "m", Op: "count", Where: []WhereTerm{term}}}); err == nil {
			t.Errorf("%s: accepted in a metric", name)
		}
	}
	// Every literal in every branch counts against MaxWhereClauses.
	term := WhereTerm{Any: []WhereClause{}}
	for len(term.Predicates()) < MaxWhereClauses {
		term.Any = append(term.Any, WhereClause{All: []WhereClause{literal, literal}})
	}
	if err := (WireQuery{Where: []WhereTerm{term}}).Validate(); err != nil {
		t.Fatal(err)
	}
	term.Any = append(term.Any, literal)
	if err := (WireQuery{Where: []WhereTerm{term}}).Validate(); err == nil {
		t.Error("101 literals accepted")
	}
	// The wire shape: a branch is {"all": [...]} alone.
	body, err := json.Marshal(WhereTerm{Any: []WhereClause{{All: []WhereClause{literal}}, literal}})
	if err != nil || string(body) != `{"any":[{"all":[{"field":"overall","op":"=","value":"PASS"}]},{"field":"overall","op":"=","value":"PASS"}]}` {
		t.Errorf("JSON %s %v", body, err)
	}
}

func TestCompile_multiSortWithTiebreak(t *testing.T) {
	s := mustSchema(t)
	for _, name := range []string{"total_ms", "id"} {
		f := s.Fields[name]
		f.ExpressionNumeric = true // v3 sorts typed numeric values.
		s.Fields[name] = f
	}
	q := WireQuery{Select: []string{"id"}, Limit: 1, OrderBy: []OrderBy{
		{Field: "total_ms", Dir: "desc"},
		{Field: "is_starred", Dir: "asc", Nulls: "first"},
	}}
	p, err := compileTestRows(context.Background(), q, s, PlanOptions{SourceSQL: "SELECT * FROM runs r"})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	// total_ms (v2 from f7), is_starred (f4), then the id tiebreak (v4 from
	// f3) and the stable identity order.
	for _, want := range []string{"r.id AS f3", "(w.tags ? 'x') AS f4", "r.total_ms AS f7", "ORDER BY v2 DESC NULLS LAST,f4 ASC NULLS FIRST,v4 DESC NULLS LAST,v4 ASC NULLS LAST LIMIT"} {
		if !strings.Contains(p.SQL, want) {
			t.Errorf("ORDER BY plan lacks %q:\n%s", want, p.SQL)
		}
	}
}

func TestWireQueryJSON_acceptsServerQueryNamesAndValidates(t *testing.T) {
	var q WireQuery
	err := json.Unmarshal([]byte(`{
		"select":["overall"],
		"where":[{"field":"overall","op":"=","value":"FAIL"}],
		"orderBy":[{"field":"case_name","dir":"asc","extract":{"regex":"item-(\\d+)"}}],
		"limit":50,
		"offset":10
	}`), &q)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if q.Limit != 50 || q.Offset != 10 || len(q.Where) != 1 || len(q.OrderBy) != 1 {
		t.Fatalf("unexpected query: %#v", q)
	}
	if q.OrderBy[0].Extract == nil || q.OrderBy[0].Extract.Regex != `item-(\d+)` {
		t.Fatalf("regex extract did not decode: %#v", q.OrderBy[0])
	}
	body, err := json.Marshal(q)
	if err != nil || string(body) != `{"select":["overall"],"where":[{"field":"overall","op":"=","value":"FAIL"}],"orderBy":[{"field":"case_name","dir":"asc","extract":{"regex":"item-(\\d+)"}}],"limit":50,"offset":10}` {
		t.Fatalf("stage JSON %s %v", body, err)
	}

	if err := json.Unmarshal([]byte(`{"limit":10000}`), &q); err != nil {
		t.Fatalf("unmarshal limit above 1000: %v", err)
	}
	if q.Limit != 10_000 {
		t.Fatalf("limit = %d, want 10000", q.Limit)
	}
}

// A stage has exactly select, where, orderBy, limit and offset: the v1
// compact aliases, aggregations and the single-object orderBy are rejected.
func TestWireQueryJSON_rejectsLegacyShapes(t *testing.T) {
	for _, payload := range []string{
		`{"s":["overall"]}`, `{"c":["overall"]}`, `{"w":[]}`, `{"o":[]}`, `{"l":10}`, `{"f":1}`, `{"g":[]}`,
		`{"aggregations":[{"id":"count","op":"count"}]}`,
		`{"orderBy":{"field":"case_name","dir":"asc"}}`,
	} {
		var q WireQuery
		if err := json.Unmarshal([]byte(payload), &q); err == nil {
			t.Errorf("%s accepted", payload)
		}
	}
}

func TestWireQueryJSON_rejectsResourceLimitViolations(t *testing.T) {
	for name, payload := range map[string]string{
		"offset": `{"offset":1000001}`,
		"value":  `{"where":[{"field":"overall","op":"=","value":"` + strings.Repeat("x", maxFilterValueBytes+1) + `"}]}`,
		"regex":  `{"orderBy":[{"field":"case_name","dir":"asc","extract":{"regex":"` + strings.Repeat("x", maxRegexBytes+1) + `"}}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			var q WireQuery
			if err := json.Unmarshal([]byte(payload), &q); err == nil {
				t.Fatal("want resource-limit error")
			}
		})
	}
}

func TestCompile_rejectsResourceLimitViolations(t *testing.T) {
	s := mustSchema(t)
	if _, _, err := compileTestWhere(WireQuery{Offset: -1}, s, 1); err == nil {
		t.Fatal("want negative offset error")
	}
}

func TestCaseSensitiveArrayMembership(t *testing.T) {
	s, err := LoadSchema([]byte(strings.Replace(schemaJSON, `"name": "function_names",`, `"name": "function_names", "filter": {"arrayCaseSensitive": true},`, 1)))
	if err != nil {
		t.Fatal(err)
	}
	spec := s.Fields["function_names"]
	if !spec.ArrayCaseSensitive {
		t.Fatal("schema dropped arrayCaseSensitive")
	}
	sql, args, _, err := compileWhere(spec, "includes", "Bug", 1)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sql, "LOWER") || !strings.Contains(sql, "_e = $1") || args[0] != "Bug" {
		t.Fatalf("%s %v", sql, args)
	}
}
