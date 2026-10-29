package postgrestests

import (
	"context"
	"reflect"
	"sort"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// An OR of AND branches selects the union of its branches as a record filter,
// a source filter and a group (HAVING) filter on PostgreSQL.
func TestPostgresOrOfAnds(t *testing.T) {
	db, d := fixture(t)
	branches := [][]qt.WhereClause{
		{{Field: "k", Op: "=", Value: "a"}, {Field: "label", Op: "contains", Value: "o", Negated: true}},
		{{Field: "k", Op: "=", Value: "b"}, {Field: "n", Op: ">=", Value: "5"}},
		{{Field: "label", Op: "=", Value: "empty"}},
	}
	term := qt.WhereTerm{Any: []qt.WhereClause{}}
	for _, branch := range branches {
		if len(branch) == 1 {
			term.Any = append(term.Any, branch[0])
		} else {
			term.Any = append(term.Any, qt.WhereClause{All: branch})
		}
	}
	ids := func(where []qt.WhereTerm) []string {
		out, err := d.Execute(context.Background(), db, qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: where, Limit: 100}}, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		list := []string{}
		for _, row := range out.Rows {
			list = append(list, row["id"].(string))
		}
		sort.Strings(list)
		return list
	}
	union := map[string]bool{}
	for _, branch := range branches {
		where := []qt.WhereTerm{}
		for _, c := range branch {
			where = append(where, qt.WhereTerm{Field: c.Field, Op: c.Op, Value: c.Value, Negated: c.Negated})
		}
		for _, id := range ids(where) {
			union[id] = true
		}
	}
	want := []string{}
	for id := range union {
		want = append(want, id)
	}
	sort.Strings(want)
	// Row 2 (k = a, NULL label) matches neither "contains o" nor its negation.
	if !reflect.DeepEqual(want, []string{"3", "4", "5"}) || !reflect.DeepEqual(ids([]qt.WhereTerm{term}), want) {
		t.Fatalf("got %v, want %v", ids([]qt.WhereTerm{term}), want)
	}

	groups := func(q qt.QueryRequestV3) []string {
		out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		keys := []string{}
		for _, row := range out.Rows {
			k, _ := row["k"].(string)
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return keys
	}
	q := groupedQuery()
	q.Source.Where = []qt.WhereTerm{term}
	if got := groups(q); !reflect.DeepEqual(got, []string{"", "a", "b"}) {
		t.Fatalf("source filter groups %v", got)
	}
	q = groupedQuery()
	q.Result.Where = []qt.WhereTerm{{Any: []qt.WhereClause{
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "a"}, {Field: "num", Op: ">=", Value: "2"}}},
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "b"}, {Field: "total", Op: ">", Value: "50"}}},
	}}}
	if got := groups(q); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("group filter groups %v", got)
	}
}
