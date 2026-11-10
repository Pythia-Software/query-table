package sqlitetests

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A host that stages only the source plan's base fields (projected map
// populations) returns the same distinct values as the unprojected source,
// including for targets that no row, metric or predicate selects.
func TestV3DistinctSourcePlanStagesTarget(t *testing.T) {
	db, d, o := ungroupedV3(t, 200)
	// Execution reads a base target's raw binding, so distinct stays available
	// for numeric bindings that typed expressions cannot read.
	lenient := d
	lenient.Schema.Fields = maps.Clone(d.Schema.Fields)
	m := lenient.Schema.Fields["m"]
	m.ExpressionNumeric = false
	lenient.Schema.Fields["m"] = m
	cases := []struct {
		dataset qt.QueryDatasetV3
		field   string
		where   []qt.WhereTerm
		inputs  []string
	}{
		{d, "note", []qt.WhereTerm{{Field: "k", Op: "=", Value: "alpha"}}, []string{"note", "k"}},
		{d, "note", nil, []string{"note"}},
		{d, "tags", []qt.WhereTerm{{Field: "e", Op: "=", Value: "low"}}, []string{"tags", "e"}},
		{d, "at", []qt.WhereTerm{{Any: []qt.WhereClause{{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "beta"}, {Field: "flag", Op: "=", Value: "true"}}}, {Field: "e", Op: "=", Value: "mid"}}}}, []string{"at", "k", "flag", "e"}},
		{d, "secs", []qt.WhereTerm{{Field: "@computed/double", Op: ">", Value: "10"}}, []string{"secs", "n"}},
		{lenient, "m", []qt.WhereTerm{{Field: "k", Op: "=", Value: "gamma"}}, []string{"m", "k"}},
		{d, "@computed/double", []qt.WhereTerm{{Field: "e", Op: "=", Value: "high"}}, []string{"n", "e"}},
		{d, "@computed/big", nil, []string{"n"}},
	}
	for _, c := range cases {
		q := ungroupedRequest(qt.WireQuery{Limit: 1})
		q.Rows, q.Source = false, qt.WireQuery{Where: c.where}
		q.Distinct = &qt.DistinctRequestV3{Field: c.field, Limit: 500}
		// inv reads m, which the lenient dataset leaves out of typed expressions.
		delete(q.ExpectedRevisions, "inv")
		plan, err := c.dataset.SourcePlan(context.Background(), q, o)
		if err != nil {
			t.Fatal(c.field, err)
		}
		for _, name := range c.inputs {
			if !slices.Contains(plan.BaseFields, name) {
				t.Fatalf("%s: base fields %v lack %s", c.field, plan.BaseFields, name)
			}
		}
		_, computed := strings.CutPrefix(c.field, "@computed/")
		if computed && !slices.Contains(plan.Fields, c.field) {
			t.Fatalf("%s: projection %v", c.field, plan.Fields)
		}
		// Stage identity and the planned base inputs; every other column is NULL.
		columns := []string{"tenant"}
		for name := range c.dataset.Schema.Fields {
			if name == "id" || slices.Contains(plan.BaseFields, name) {
				columns = append(columns, name)
			} else {
				columns = append(columns, "NULL AS "+name)
			}
		}
		staged := c.dataset
		staged.SourceSQL = strings.Replace(d.SourceSQL, "SELECT *", "SELECT "+strings.Join(columns, ","), 1)
		read := func(d qt.QueryDatasetV3) qt.QueryResultV3 {
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			out, err := d.ExecuteIn(context.Background(), tx, q, o)
			if err != nil {
				t.Fatal(c.field, err)
			}
			return out
		}
		want, got := read(c.dataset), read(staged)
		if len(want.Distinct.Values) == 0 || !reflect.DeepEqual(want.Distinct, got.Distinct) {
			t.Fatalf("%s over %v: staged %#v, source %#v", c.field, plan.BaseFields, got.Distinct, want.Distinct)
		}
		// The response reports the computed target's execution capability.
		if _, reported := want.Execution.Fields[c.field]; reported != computed {
			t.Fatalf("%s: execution fields %v", c.field, want.Execution.Fields)
		}
	}
	var diag *qt.PlanDiagnostic
	// A computed target needs its revision while planning, not only executing.
	q := ungroupedRequest(qt.WireQuery{Limit: 1})
	q.Rows, q.ExpectedRevisions = false, nil
	q.Distinct = &qt.DistinctRequestV3{Field: "@computed/double", Limit: 5}
	if _, err := d.SourcePlan(context.Background(), q, o); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeDefinitionChanged {
		t.Fatalf("computed target without its revision planned: %v", err)
	}
	// A target the host does not let requests filter is rejected while planning.
	q = ungroupedRequest(qt.WireQuery{Limit: 1})
	q.Rows, q.Distinct = false, &qt.DistinctRequestV3{Field: "@computed/inv", Limit: 5}
	if _, err := d.SourcePlan(context.Background(), q, o); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeInvalidQuery {
		t.Fatalf("unfilterable distinct target planned: %v", err)
	}
}
