package sqlitetests

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// 150 KB exceeds the 100,000-byte formula text bound but is an ordinary value
// for display, filters and sorting.
var longText = "zz " + strings.Repeat("long message ", 150000/13)

func echoResolver(source string) qt.PlanOptions {
	return qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Echo", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: source}}, nil
	})}
}

func TestV2LongTextRowsAreReturnedIntact(t *testing.T) {
	db, d := setupV2(t)
	if _, e := db.Exec("INSERT INTO runs VALUES('f','one',?,8,'[]',NULL,0)", longText); e != nil {
		t.Fatal(e)
	}
	o := echoResolver("[text]")
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, ExpectedRevisions: map[string]string{"echo": "1"}, WireQuery: qt.WireQuery{Select: []string{"id", "text", "@computed/echo"}, OrderBy: []qt.OrderBy{{Field: "n", Dir: "desc"}}, Limit: 2}}
	r, e := d.ExecuteV2(context.Background(), db, &q, nil, o)
	if e != nil {
		t.Fatal(e)
	}
	rows := r.Rows
	if rows.Total != 5 || len(rows.Rows) != 2 || rows.Rows[0]["id"] != "f" || rows.Rows[0]["text"] != longText || rows.Rows[1]["text"] != nil {
		t.Fatalf("long row page: total=%d rows=%d first=%v", rows.Total, len(rows.Rows), rows.Rows[0]["id"])
	}
	// The formula bound is still a per-value error, never a page failure.
	echo := rows.Computed[0].Values["echo"]
	if echo.Value != nil || echo.Error == nil || echo.Error.Code != "text_range" || rows.Computed[1].Values["echo"].Error != nil {
		t.Fatalf("computed over long text: %#v", rows.Computed)
	}
	// Second page is unaffected.
	q.Offset = 2
	if r, e = d.ExecuteV2(context.Background(), db, &q, nil, o); e != nil || len(r.Rows.Rows) != 2 || r.Rows.Rows[0]["text"] != "école" {
		t.Fatalf("second page: %v %#v", e, r.Rows)
	}

	// Filters and sorting see the full value instead of a NULL placeholder.
	q = qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id", "text"}, Where: []qt.WhereTerm{{Field: "text", Op: "contains", Value: "long message"}}, Limit: 10}}
	if r, e = d.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{}); e != nil || r.Rows.Total != 1 || r.Rows.Rows[0]["text"] != longText {
		t.Fatalf("contains: %v", e)
	}
	q = qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "text", Dir: "desc", Nulls: "last"}}, Limit: 10}}
	r, e = d.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	order := []any{}
	for _, row := range r.Rows.Rows {
		order = append(order, row["id"])
	}
	if !reflect.DeepEqual(order, []any{"b", "a", "f", "c", "d"}) {
		t.Fatalf("sort: %v", order)
	}
	metric := metricV2("COUNT()")
	metric.OrderBy, metric.Limit, metric.Metrics[0].Scope = q.OrderBy, 1, "shownRows"
	metric.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "f"}}
	if r, e = d.ExecuteV2(context.Background(), db, nil, &metric, qt.PlanOptions{}); e != nil || r.Metrics.Metrics[0].Buckets[0].Value != float64(1) {
		t.Fatalf("shownRows metric over long sort key: %v", e)
	}
}

func TestV2InvalidUTF8RemainsSourceError(t *testing.T) {
	db, d := setupV2(t)
	if _, e := db.Exec("INSERT INTO runs VALUES('f','one',CAST(x'ff' AS TEXT),8,'[]',NULL,0)"); e != nil {
		t.Fatal(e)
	}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id", "text"}, Limit: 10}}
	var diag *qt.PlanDiagnostic
	if _, e := d.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{}); !errors.As(e, &diag) || diag.Code != "text_encoding" {
		t.Fatalf("invalid UTF-8: %v", e)
	}
}

func TestV3LongTextRowsAreReturnedIntact(t *testing.T) {
	db, d := setupV3(t)
	if _, err := db.Exec("UPDATE grouped SET label=? WHERE id='4'", longText); err != nil {
		t.Fatal(err)
	}
	q := groupedRequest()
	q.Grouping = nil
	q.ExpectedRevisions = map[string]string{"echo": "1"}
	q.Result = qt.WireQuery{Select: []string{"id", "label", "@computed/echo"}, OrderBy: qt.OrderBys{{Field: "n", Dir: "desc"}}, Limit: 2}
	o := echoResolver("[label]")
	out, err := d.Execute(context.Background(), db, q, o)
	if err != nil {
		t.Fatal(err)
	}
	if out.Total != 6 || len(out.Rows) != 2 || out.Rows[0]["id"] != "4" || out.Rows[0]["label"] != longText {
		t.Fatalf("long row page: %d %v", out.Total, out.Rows[0]["id"])
	}
	if !reflect.DeepEqual(out.Rows[0]["@computed/echo"], map[string]any{"computedError": "text_range"}) || out.Rows[1]["@computed/echo"] != "null" {
		t.Fatalf("computed cells: %#v %#v", out.Rows[0]["@computed/echo"], out.Rows[1]["@computed/echo"])
	}
	q.Result = qt.WireQuery{Select: []string{"id", "label"}, Where: []qt.WhereTerm{{Field: "label", Op: "contains", Value: "long message"}}, OrderBy: qt.OrderBys{{Field: "label", Dir: "desc"}}, Limit: 10}
	q.ExpectedRevisions = nil
	if out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil || out.Total != 1 || out.Rows[0]["label"] != longText {
		t.Fatalf("contains: %v %#v", err, out.Total)
	}
	// Grouped representative ROW values are plain projections too.
	q = groupedRequest()
	q.Source = qt.WireQuery{}
	q.Result.OrderBy = qt.OrderBys{{Field: "k", Dir: "asc", Nulls: "last"}}
	if out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if out.Rows[2]["k"] != "b" || out.Rows[2]["example"] != longText {
		t.Fatalf("representative: %#v", out.Rows[2]["k"])
	}
}
