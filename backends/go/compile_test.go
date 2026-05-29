package querytable

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

const schemaJSON = `{
  "name": "runs",
  "idField": "id",
  "tiebreakSort": [{"field": "id", "dir": "desc"}],
  "fields": [
    {"name": "id", "label": "ID", "type": "number", "bindings": {"postgres": {"expr": "vr.id"}}},
    {"name": "overall", "label": "Overall", "type": "enum", "bindings": {"postgres": {"expr": "vr.overall"}}},
    {"name": "total_ms", "label": "Total", "type": "number", "bindings": {"postgres": {"expr": "vr.total_ms"}}},
    {"name": "is_starred", "label": "Star", "type": "bool", "sort": {"field": "is_starred"},
      "bindings": {"postgres": {"expr": "(w.tags ? 'x')", "synthetic": true}}},
    {"name": "function_names", "label": "Fns", "type": "textarray", "bindings": {"postgres": {"expr": "w.fn_names"}}},
    {"name": "failed_steps", "label": "Failed", "type": "textarray", "filter": {"pushdown": false},
      "bindings": {"postgres": {"expr": "vr.failed_steps"}}},
    {"name": "deviations", "label": "D", "type": "text", "source": "derived"}
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
	if _, ok := s.Fields["deviations"]; ok {
		t.Error("derived field should be absent from the backend schema")
	}
	if len(s.Fields) != 6 {
		t.Errorf("want 6 backend fields, got %d", len(s.Fields))
	}
	if s.Fields["failed_steps"].ServerFilter {
		t.Error("failed_steps has pushdown:false → ServerFilter should be false")
	}
}

func TestCompile_where(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{Where: []WhereClause{
		{Field: "overall", Op: "=", Value: "FAIL"},
		{Field: "total_ms", Op: ">", Value: "100"},
		{Field: "function_names", Op: "includes", Value: "SUM"},
	}}
	res, next, err := Compile(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "(vr.overall = $1) AND (vr.total_ms > $2) AND " +
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
	_, _, err := Compile(WireQuery{Where: []WhereClause{{Field: "failed_steps", Op: "includes", Value: "x"}}}, s, 1)
	if err == nil || !strings.Contains(err.Error(), "not server-filterable") {
		t.Errorf("want not-server-filterable error, got %v", err)
	}
}

func TestCompile_opMatrix(t *testing.T) {
	s := mustSchema(t)
	// '>' is invalid on an enum.
	if _, _, err := Compile(WireQuery{Where: []WhereClause{{Field: "overall", Op: ">", Value: "x"}}}, s, 1); err == nil {
		t.Error("want error for '>' on enum")
	}
	// is_null is valid on bool (nullity on every type).
	res, _, err := Compile(WireQuery{Where: []WhereClause{{Field: "is_starred", Op: "is_null", Value: ""}}}, s, 1)
	if err != nil || res.WhereSQL != "((w.tags ? 'x') IS NULL)" {
		t.Errorf("bool is_null: sql=%q err=%v", res.WhereSQL, err)
	}
}

func TestCompile_multiSortWithTiebreak(t *testing.T) {
	s := mustSchema(t)
	q := WireQuery{OrderBy: OrderBys{
		{Field: "total_ms", Dir: "desc"},
		{Field: "is_starred", Dir: "asc", Nulls: "first"},
	}}
	res, _, err := Compile(q, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := "vr.total_ms DESC NULLS LAST, (w.tags ? 'x') ASC NULLS FIRST, vr.id DESC NULLS LAST"
	if res.OrderSQL != want {
		t.Errorf("OrderSQL\n got: %s\nwant: %s", res.OrderSQL, want)
	}
}

func TestCompile_select(t *testing.T) {
	s := mustSchema(t)
	res, _, err := Compile(WireQuery{Select: []string{"overall", "is_starred"}}, s, 1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	want := []string{`vr.overall AS "overall"`, `(w.tags ? 'x') AS "is_starred"`}
	if !reflect.DeepEqual(res.SelectExprs, want) {
		t.Errorf("SelectExprs = %#v, want %#v", res.SelectExprs, want)
	}
	if _, _, err := Compile(WireQuery{Select: []string{"nope"}}, s, 1); err == nil {
		t.Error("want error for unknown select field")
	}
}

func TestDecodeWireQuery_legacyShapes(t *testing.T) {
	// legacy: o is a single object, c is a string[]
	token := b64url(`{"o":{"field":"total_ms","dir":"desc"},"c":["overall","total_ms"],"l":50,"w":[{"field":"overall","op":"=","value":"FAIL"}]}`)
	q, err := DecodeWireQuery(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(q.OrderBy) != 1 || q.OrderBy[0].Field != "total_ms" {
		t.Errorf("legacy orderBy not normalized: %#v", q.OrderBy)
	}
	if !reflect.DeepEqual(q.Select, []string{"overall", "total_ms"}) {
		t.Errorf("legacy select = %#v", q.Select)
	}
	if q.Limit != 50 || len(q.Where) != 1 {
		t.Errorf("limit/where wrong: %d %#v", q.Limit, q.Where)
	}
}

func TestDecodeWireQuery_tupleSelect(t *testing.T) {
	token := b64url(`{"s":[["overall"],["total_ms",240]],"o":[{"field":"id","dir":"asc"}]}`)
	q, err := DecodeWireQuery(token)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !reflect.DeepEqual(q.Select, []string{"overall", "total_ms"}) {
		t.Errorf("tuple select = %#v", q.Select)
	}
	if len(q.OrderBy) != 1 || q.OrderBy[0].Field != "id" {
		t.Errorf("orderBy = %#v", q.OrderBy)
	}
}

func TestCompileDistinct(t *testing.T) {
	s := mustSchema(t)
	dc, next, err := CompileDistinct("overall", "FA", s, 1)
	if err != nil {
		t.Fatalf("CompileDistinct: %v", err)
	}
	if dc.Expr != "vr.overall" {
		t.Errorf("expr = %q", dc.Expr)
	}
	if dc.SearchSQL != "POSITION(LOWER($1) IN LOWER(vr.overall::text)) > 0" {
		t.Errorf("searchSQL = %q", dc.SearchSQL)
	}
	if next != 2 || !reflect.DeepEqual(dc.Args, []any{"FA"}) {
		t.Errorf("next=%d args=%#v", next, dc.Args)
	}
}

// b64url mimics @query-table/core encodeQuery's charset (base64url, no padding).
func b64url(json string) string {
	s := base64.StdEncoding.EncodeToString([]byte(json))
	s = strings.TrimRight(s, "=")
	s = strings.ReplaceAll(s, "+", "-")
	s = strings.ReplaceAll(s, "/", "_")
	return s
}
