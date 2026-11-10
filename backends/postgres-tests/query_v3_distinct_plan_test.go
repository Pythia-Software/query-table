package postgrestests

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A host that stages only the source plan's base fields returns the same
// distinct values as the unprojected source, including for targets that no
// row, metric or predicate selects.
func TestPostgresDistinctSourcePlanStagesTarget(t *testing.T) {
	db, d, o := ungroupedV3(t, 200)
	types := map[string]string{"id": "text", "k": "text", "e": "text", "n": "double precision", "m": "bigint", "at": "timestamptz", "flag": "boolean", "tags": "text[]", "note": "text"}
	cases := []struct {
		field  string
		where  []qt.WhereTerm
		inputs []string
	}{
		{"note", []qt.WhereTerm{{Field: "k", Op: "=", Value: "alpha"}}, []string{"note", "k"}},
		{"note", nil, []string{"note"}},
		{"tags", []qt.WhereTerm{{Field: "e", Op: "=", Value: "low"}}, []string{"tags", "e"}},
		{"at", []qt.WhereTerm{{Any: []qt.WhereClause{{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "beta"}, {Field: "flag", Op: "=", Value: "true"}}}, {Field: "e", Op: "=", Value: "mid"}}}}, []string{"at", "k", "flag", "e"}},
		{"m", []qt.WhereTerm{{Field: "@computed/double", Op: ">", Value: "10"}}, []string{"m", "n"}},
		{"@computed/double", []qt.WhereTerm{{Field: "e", Op: "=", Value: "high"}}, []string{"n", "e"}},
		{"@computed/big", nil, []string{"n"}},
	}
	for _, c := range cases {
		q := ungroupedRequest(qt.WireQuery{Limit: 1})
		q.Rows, q.Source = false, qt.WireQuery{Where: c.where}
		q.Distinct = &qt.DistinctRequestV3{Field: c.field, Limit: 500}
		plan, err := d.SourcePlan(context.Background(), q, o)
		if err != nil {
			t.Fatal(c.field, err)
		}
		for _, name := range c.inputs {
			if !slices.Contains(plan.BaseFields, name) {
				t.Fatalf("%s: base fields %v lack %s", c.field, plan.BaseFields, name)
			}
		}
		if id, computed := strings.CutPrefix(c.field, "@computed/"); computed && plan.ResolvedRevisions[id] != "1" {
			t.Fatalf("%s: revisions %v", c.field, plan.ResolvedRevisions)
		}
		// Stage identity and the planned base inputs; every other column is NULL.
		columns := []string{"tenant"}
		for name := range d.Schema.Fields {
			if name == "id" || slices.Contains(plan.BaseFields, name) {
				columns = append(columns, name)
			} else {
				columns = append(columns, "NULL::"+types[name]+" AS "+name)
			}
		}
		staged := d
		staged.SourceSQL = strings.Replace(d.SourceSQL, "SELECT *", "SELECT "+strings.Join(columns, ","), 1)
		read := func(d qt.QueryDatasetV3) *qt.DistinctResultV3 {
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			out, err := d.ExecuteIn(context.Background(), tx, q, o)
			if err != nil {
				t.Fatal(c.field, err)
			}
			return out.Distinct
		}
		want, got := read(d), read(staged)
		if len(want.Values) == 0 || !reflect.DeepEqual(want, got) {
			t.Fatalf("%s over %v: staged %#v, source %#v", c.field, plan.BaseFields, got, want)
		}
	}
}
