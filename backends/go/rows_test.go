package querytable

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func TestRowsReductionVisits(t *testing.T) {
	s := Schema{Name: "rows", IDField: "id", Fields: map[string]FieldSpec{}}
	for _, name := range []string{"id", "provider", "session"} {
		s.Fields[name] = FieldSpec{Name: name, Kind: FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true}
	}
	q := MetricQuery{Version: 2, Where: []WhereTerm{{Field: "provider", Op: "=", Value: "a"}}}
	row := map[string]any{"id": "one", "provider": "a", "session": "s"}
	for i := range 5 {
		name := fmt.Sprintf("n%d", i)
		s.Fields[name] = FieldSpec{Name: name, Kind: FieldNumber, Expr: "r." + name, ExpressionNumeric: true}
		row[name] = int64(i + 1)
		q.Metrics = append(q.Metrics, AggSpec{ID: name, Op: "sum", Field: name, GroupBy: []string{"provider"}})
	}
	q.Metrics = append(q.Metrics, AggSpec{ID: "sessions", Op: "count_distinct", Field: "session", GroupBy: []string{"provider"}})
	rows := make([]map[string]any, 1000)
	for i := range rows {
		rows[i] = row
	}
	visits := 0
	result, e := executeV2Rows(context.Background(), nil, SQLiteV2Dataset{Schema: s}, rows, q, PlanOptions{}, func() { visits++ })
	if e != nil {
		t.Fatal(e)
	}
	if visits != len(rows) {
		t.Fatalf("%d row visits for %d rows", visits, len(rows))
	}
	for i, m := range result.Metrics.Metrics {
		want := float64(1000 * (i + 1))
		if i == 5 {
			want = 1
		}
		if m.Buckets[0].Value != want {
			t.Fatalf("%+v", m)
		}
	}
}
func TestRowsFilterCompilation(t *testing.T) {
	s := Schema{Fields: map[string]FieldSpec{"text": {Kind: FieldText, Expr: "r.text", ServerFilter: true}, "n": {Kind: FieldNumber, Expr: "r.n", ServerFilter: true}, "stamp": {Kind: FieldDatetime, Expr: "r.stamp", ServerFilter: true}, "disabled": {Kind: FieldText, Expr: "r.disabled"}, "restricted": {Kind: FieldText, Expr: "r.restricted", ServerFilter: true, FilterOps: []string{"="}}}}
	for _, c := range []WhereTerm{{Field: "missing", Op: "=", Value: "x"}, {Field: "disabled", Op: "=", Value: "x"}, {Field: "restricted", Op: "contains", Value: "x"}, {Field: "text", Op: "matches_regex", Value: "["}, {Field: "text", Op: "length_eq", Value: "01"}, {Field: "text", Op: "length_eq", Value: "-1"}, {Field: "text", Op: "length_eq", Value: "+1"}, {Field: "text", Op: "length_eq", Value: "9007199254740992"}, {Field: "n", Op: "=", Value: "NaN"}, {Field: "n", Op: "=", Value: "Inf"}, {Field: "stamp", Op: "=", Value: "yesterday"}, {Field: "stamp", Op: "=", Value: "-invalid"}, {Any: []WhereClause{}}, {Any: []WhereClause{{Field: "n", Op: "=", Value: ""}, {Field: "missing", Op: "=", Value: "x"}}}} {
		_, e := CompileRowFilter([]WhereTerm{c}, s, SQLiteOptions{})
		_, want := CompileSQLiteWhere([]WhereTerm{c}, s, SQLiteOptions{})
		if e == nil || want == nil || e.Error() != want.Error() {
			t.Fatalf("%+v: %v / %v", c, e, want)
		}
	}
	for _, name := range []string{"@computed/test", "text"} {
		if name == "text" {
			f := s.Fields[name]
			f.Expr = "lower(r.text)"
			s.Fields[name] = f
		}
		if _, e := CompileRowFilter([]WhereTerm{{Field: name, Op: "=", Value: "x"}}, s, SQLiteOptions{}); !errors.Is(e, ErrRowsUnsupported) {
			t.Fatal(e)
		}
	}
}
func TestRowsUnsupportedStorage(t *testing.T) {
	s := Schema{Fields: map[string]FieldSpec{"text": {Kind: FieldText, Expr: "r.text", ServerFilter: true}}}
	filter, e := CompileRowFilter([]WhereTerm{{Field: "text", Op: "contains", Value: "x"}}, s, SQLiteOptions{})
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range []any{int64(12), []string{"x"}, "x\x00y", string([]byte{0xff})} {
		if _, e = filter.Match(map[string]any{"text": v}); !errors.Is(e, ErrRowsUnsupported) {
			t.Fatalf("%T %v", v, e)
		}
	}
	empty := RowFilter{}
	if yes, e := empty.Match(nil); !yes || e != nil {
		t.Fatal(yes, e)
	}
	// A blank alternative makes the entire OR group a no-op, after validation.
	s.Fields["n"] = FieldSpec{Kind: FieldNumber, Expr: "r.n", ServerFilter: true}
	filter, e = CompileRowFilter([]WhereTerm{{Any: []WhereClause{{Field: "n", Op: ">", Value: ""}, {Field: "text", Op: "=", Value: "x"}}}}, s, SQLiteOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if yes, e := filter.Match(nil); !yes || e != nil {
		t.Fatal(yes, e)
	}
}
func TestSQLiteRowValues(t *testing.T) {
	s := Schema{Fields: map[string]FieldSpec{"text": {Kind: FieldText}, "flag": {Kind: FieldBool}, "stamp": {Kind: FieldDatetime}}}
	values, e := SQLiteRowValues(map[string]any{"flag": true, "stamp": ""}, s, []string{"text", "flag", "stamp"})
	if e != nil || !reflect.DeepEqual(values, []any{nil, int64(1), nil}) {
		t.Fatal(values, e)
	}
}
