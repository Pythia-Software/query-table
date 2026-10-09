package sqlitetests

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
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
			q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "stamp_label", Dir: test.dir}}, Limit: 1, Offset: test.offset}}
			m := metricV2("SUM([n])")
			m.OrderBy, m.Limit, m.Offset = q.OrderBy, q.Limit, q.Offset
			m.Metrics[0].Scope = "shownRows"
			result, err := d.ExecuteV2(context.Background(), db, &q, &m, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Rows.Rows) != 1 || result.Rows.Rows[0]["id"] != test.id || result.Metrics.Metrics[0].Buckets[0].Value != test.value {
				t.Fatalf("expected page %s and shownRows sum %v, got %#v / %#v", test.id, test.value, result.Rows.Rows, result.Metrics.Metrics[0].Buckets)
			}
		})
	}
}

func TestCompactSQLiteQueryPreservesSelection(t *testing.T) {
	db, d := setup(t)
	for _, body := range []string{
		`{"s":[["id",100]],"l":10}`,
		`{"s":[["id"]],"l":10}`,
		`{"s":["id"],"l":10}`,
		`{"c":["id"],"l":10}`,
		`{"select":["id"],"s":[["n",100]],"l":10}`,
	} {
		t.Run(body, func(t *testing.T) {
			q, err := qt.DecodeSQLiteQuery([]byte(body))
			if err != nil || !reflect.DeepEqual(q.Select, []string{"id"}) {
				t.Fatalf("expected id selection, got %#v, %v", q, err)
			}
			result, err := d.Rows(context.Background(), db, q)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Rows) != 4 {
				t.Fatal(result)
			}
			for _, row := range result.Rows {
				if len(row) != 1 || row["id"] == nil {
					t.Fatalf("expected only id, got %#v", row)
				}
			}
		})
	}
	for _, body := range []string{`{"s":[[""]]}`, `{"c":[""]}`} {
		if _, err := qt.DecodeSQLiteQuery([]byte(body)); err == nil {
			t.Fatalf("accepted invalid compact selection: %s", body)
		}
	}
}

func TestSQLiteAggregationRejectsResidualDiagnostics(t *testing.T) {
	db, d := setup(t)
	var request qt.SQLiteAggregationRequest
	body := []byte(`{"where":[],"aggregations":[{"id":"count","op":"count"}],"diagnostics":[{"code":"residual_filter","message":"Client-only filter omitted","from":0,"to":1}]}`)
	err := json.Unmarshal(body, &request)
	var diagnostic *qt.PlanDiagnostic
	if !errors.As(err, &diagnostic) || diagnostic.Code != "residual_query" {
		t.Fatalf("expected residual diagnostic at JSON boundary, got %v", err)
	}
	// A caller that builds requests directly must receive the same rejection.
	request = qt.SQLiteAggregationRequest{Aggregations: []qt.AggSpec{{ID: "count", Op: "count"}}, Diagnostics: []any{map[string]any{"code": "residual_filter"}}}
	if _, err = d.Aggregations(context.Background(), db, request); !errors.As(err, &diagnostic) || diagnostic.Code != "residual_query" {
		t.Fatalf("expected residual diagnostic at execution boundary, got %v", err)
	}
	if err = json.Unmarshal([]byte(`{"where":[],"aggregations":[{"id":"count","op":"count"}],"diagnostics":[]}`), &request); err != nil {
		t.Fatal(err)
	}
	result, err := d.Aggregations(context.Background(), db, request)
	if err != nil || result.Metrics[0].Buckets[0].Value != int64(4) {
		t.Fatal(result, err)
	}
}
