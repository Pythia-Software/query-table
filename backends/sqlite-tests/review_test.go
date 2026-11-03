package sqlitetests

import (
	"context"
	"errors"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestV2SortTargetWithSameSQLExpression(t *testing.T) {
	db, d := setupV2(t)
	if _, err := db.Exec("UPDATE runs SET stamp='2025-12-31T23:00:00Z' WHERE id='b'"); err != nil {
		t.Fatal(err)
	}
	d.Schema.Fields["stamp_label"] = qt.FieldSpec{Name: "stamp_label", Kind: qt.FieldText, Expr: "r.stamp", SortExpr: "r.stamp", SQLiteSortField: "stamp", Sortable: true}
	for _, test := range []struct {
		dir, id string
		offset  int
		value   float64
	}{{"asc", "a", 0, 2}, {"asc", "b", 1, 4}, {"desc", "b", 1, 4}, {"desc", "a", 2, 2}} {
		t.Run(test.dir+test.id, func(t *testing.T) {
			q := v3Request(qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "stamp_label", Dir: test.dir}}, Limit: 1, Offset: test.offset}, true, qt.AggSpec{ID: "m", Expression: "SUM([n])", Scope: "shownRows"})
			result := executeV3(t, db, d, q, qt.PlanOptions{})
			if len(result.Rows) != 1 || result.Rows[0]["id"] != test.id || result.Metrics[0].Buckets[0].Value != test.value {
				t.Fatalf("expected page %s and shownRows sum %v, got %#v / %#v", test.id, test.value, result.Rows, result.Metrics[0].Buckets)
			}
		})
	}
}

func TestSQLiteAggregationRejectsResidualDiagnostics(t *testing.T) {
	db, d := setup(t)
	// v3 carries residual diagnostics as strings and rejects any as a version
	// diagnostic; v1 used objects and the residual_query code.
	body := []byte(`{"version":3,"profile":"` + qt.SQLiteExpressionProfile + `","now":0,"source":{},"result":{"where":[],"limit":1},"rows":false,"metrics":[{"id":"count","op":"count"}],"diagnostics":["residual_filter"]}`)
	request, err := qt.DecodeQueryRequestV3(body)
	var diagnostic *qt.PlanDiagnostic
	if !errors.As(err, &diagnostic) || diagnostic.Code != "version" {
		t.Fatalf("expected residual diagnostic at JSON boundary, got %v", err)
	}
	// A caller that builds requests directly must receive the same rejection.
	request = metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "count", Op: "count"})
	request.Diagnostics = []string{"residual_filter"}
	if _, err = d.Execute(context.Background(), db, request, qt.PlanOptions{}); !errors.As(err, &diagnostic) || diagnostic.Code != "version" {
		t.Fatalf("expected residual diagnostic at execution boundary, got %v", err)
	}
	body = []byte(`{"version":3,"profile":"` + qt.SQLiteExpressionProfile + `","now":0,"source":{},"result":{"where":[],"limit":1},"rows":false,"metrics":[{"id":"count","op":"count"}],"diagnostics":[]}`)
	if request, err = qt.DecodeQueryRequestV3(body); err != nil {
		t.Fatal(err)
	}
	result, err := d.Execute(context.Background(), db, request, qt.PlanOptions{})
	// v3 metric values are JSON numbers (float64); v1 returned SQLite integers.
	if err != nil || result.Metrics[0].Buckets[0].Value != float64(4) {
		t.Fatal(result, err)
	}
}
