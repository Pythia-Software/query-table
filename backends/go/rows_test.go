package querytable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
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

func TestRowsGroupIdentity(t *testing.T) {
	c := &rowMetricCohort{groupBy: []string{"a", "b", "flag"}, groups: map[string]*rowMetricGroup{},
		groupFields: []rowMetricGroupField{
			{name: "a", binding: FieldSpec{Kind: FieldText}},
			{name: "b", binding: FieldSpec{Kind: FieldEnum}},
			{name: "flag", binding: FieldSpec{Kind: FieldBool}},
		}}
	// Include encoding markers, multibyte lengths, JSON escapes and tuples
	// that would collide if concatenated or separated with a delimiter.
	texts := []any{nil, "", "a", "ab", "b", "bc", "c", "null", "false", "true", "\x01\x02\x03", "\"\\\n", "é🙂", strings.Repeat("x", 130)}
	groups := map[string]*rowMetricGroup{}
	var rows []map[string]any
	for _, a := range texts {
		for _, b := range texts {
			for _, flag := range []any{nil, false, true} {
				row := map[string]any{"a": a, "b": b, "flag": flag}
				g, err := c.group(row, 1000)
				if err != nil || g == nil {
					t.Fatalf("%v: %v", row, err)
				}
				key, _ := json.Marshal([]any{a, b, flag})
				groups[string(key)] = g
				rows = append(rows, row)
			}
		}
	}
	if len(c.groups) != len(rows) {
		t.Fatalf("%d groups for %d distinct tuples", len(c.groups), len(rows))
	}
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		keys := []any{row["a"], row["b"], row["flag"]}
		key, _ := json.Marshal(keys)
		// Native bool and SQL-style 0/1 storage must identify the same group.
		if flag, ok := row["flag"].(bool); ok {
			row["flag"] = int64(0)
			if flag {
				row["flag"] = int64(1)
			}
		}
		g, err := c.group(row, len(rows))
		if err != nil || g != groups[string(key)] || !reflect.DeepEqual(g.keys, keys) {
			t.Fatalf("group changed: %v: %+v, %v", keys, g, err)
		}
	}
	if allocs := testing.AllocsPerRun(100, func() { _, _ = c.group(rows[1], len(rows)) }); allocs != 0 {
		t.Fatalf("group hits allocate %g times", allocs)
	}
	if g, err := c.group(map[string]any{"a": "new"}, len(rows)); err != nil || g != nil || !c.overflow || c.groups != nil {
		t.Fatalf("group budget not enforced: %+v, %v", g, err)
	}
}

func TestRowsGroupStorageValidation(t *testing.T) {
	for _, tc := range []struct {
		row     map[string]any
		message string
	}{
		{map[string]any{"flag": int64(-1)}, "grouping storage flag"},
		{map[string]any{"flag": int64(255)}, "grouping storage flag"},
		{map[string]any{"flag": int64(256)}, "grouping storage flag"},
		{map[string]any{"flag": "false"}, "grouping storage flag"},
		{map[string]any{"a": int64(0)}, "grouping storage a"},
		{map[string]any{"a": "x\x00y", "flag": []string{}}, "embedded NUL text"},
		{map[string]any{"a": string([]byte{0xff}), "flag": []string{}}, "grouping storage a"},
		{map[string]any{"a": strings.Repeat("x", maxFormulaTextBytes+1), "flag": []string{}}, "grouping storage a"},
	} {
		c := &rowMetricCohort{groups: map[string]*rowMetricGroup{}, groupFields: []rowMetricGroupField{
			{name: "a", binding: FieldSpec{Kind: FieldText}},
			{name: "flag", binding: FieldSpec{Kind: FieldBool}},
		}}
		null, err := c.group(nil, 1)
		if err != nil || null == nil {
			t.Fatal(err)
		}
		if g, err := c.group(map[string]any{"a": math.NaN(), "flag": math.NaN()}, 1); err != nil || g != null {
			t.Fatalf("NaN must identify the NULL group: %+v, %v", g, err)
		}
		g, err := c.group(tc.row, 1)
		if g != nil || !errors.Is(err, ErrRowsUnsupported) || !strings.Contains(err.Error(), tc.message) || c.overflow {
			t.Fatalf("expected %s before budget failure; got %+v, %v", tc.message, g, err)
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
