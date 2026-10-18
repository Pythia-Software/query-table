package postgrestests

import (
	"context"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// 150 KB exceeds the 100,000-byte formula text bound but is an ordinary value
// for display, filters and sorting.
var longText = "zz " + strings.Repeat("long message ", 150000/13)

func TestPostgresLongTextRowsAreReturnedIntact(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec("UPDATE fixture SET label=$1 WHERE id='4'", longText); err != nil {
		t.Fatal(err)
	}
	q := groupedQuery()
	q.Grouping = nil
	q.ExpectedRevisions = map[string]string{"echo": "1"}
	q.Result = qt.WireQuery{Select: []string{"id", "label", "@computed/echo"}, OrderBy: qt.OrderBys{{Field: "n", Dir: "desc"}}, Limit: 2}
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Echo", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[label]"}}, nil
	})}
	out, err := d.Execute(context.Background(), db, q, o)
	if err != nil {
		t.Fatal(err)
	}
	if out.Total != 6 || len(out.Rows) != 2 || out.Rows[0]["id"] != "4" || out.Rows[0]["label"] != longText {
		t.Fatalf("long row page: %d %v", out.Total, out.Rows[0]["id"])
	}
	// The formula bound is still a per-value error, never a page failure.
	if !reflect.DeepEqual(out.Rows[0]["@computed/echo"], map[string]any{"computedError": "text_range"}) || out.Rows[1]["@computed/echo"] != "null" {
		t.Fatalf("computed cells: %#v %#v", out.Rows[0]["@computed/echo"], out.Rows[1]["@computed/echo"])
	}
	q.Result.Offset = 2
	if out, err = d.Execute(context.Background(), db, q, o); err != nil || len(out.Rows) != 2 || out.Rows[0]["id"] != "2" {
		t.Fatalf("second page: %v %#v", err, out.Rows)
	}

	// Filters and sorting see the full value instead of a NULL placeholder.
	q.ExpectedRevisions = nil
	q.Result = qt.WireQuery{Select: []string{"id", "label"}, Where: []qt.WhereTerm{{Field: "label", Op: "contains", Value: "long message"}}, Limit: 10}
	if out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil || out.Total != 1 || out.Rows[0]["label"] != longText {
		t.Fatalf("contains: %v %d", err, out.Total)
	}
	q.Result = qt.WireQuery{Select: []string{"id"}, OrderBy: qt.OrderBys{{Field: "label", Dir: "desc", Nulls: "last"}}, Limit: 10}
	if out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	order := []any{}
	for _, row := range out.Rows {
		order = append(order, row["id"])
	}
	if !reflect.DeepEqual(order, []any{"4", "3", "1", "6", "5", "2"}) {
		t.Fatalf("sort: %v", order)
	}

	// Grouped representative ROW values are plain projections too.
	q = groupedQuery()
	q.Source = qt.WireQuery{}
	q.Result.OrderBy = qt.OrderBys{{Field: "k", Dir: "asc", Nulls: "last"}}
	if out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if out.Rows[2]["k"] != "b" || out.Rows[2]["example"] != longText {
		t.Fatalf("representative: %#v", out.Rows[2]["k"])
	}
}
