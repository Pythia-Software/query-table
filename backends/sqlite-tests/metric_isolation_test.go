package sqlitetests

import (
	"context"
	"errors"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func assertMiddleMetricFailed(t *testing.T, metrics []qt.SQLiteMetricV2, sum, count float64, message string) {
	t.Helper()
	if len(metrics) != 3 {
		t.Fatalf("metrics=%d", len(metrics))
	}
	first, middle, last := metrics[0], metrics[1], metrics[2]
	if first.Error != "" || first.Buckets[0].Value != sum || last.Error != "" || last.Buckets[0].Value != count {
		t.Fatalf("siblings: %#v %#v", first, last)
	}
	if middle.ID != "middle" || middle.Error != message || len(middle.Buckets) != 0 {
		t.Fatalf("middle: %#v", middle)
	}
}

func TestV2MiddleMetricFailureIsIsolated(t *testing.T) {
	db, d := setupV2(t)
	d.MaxGroups = 2
	rows := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, Limit: 10}}
	for name, middle := range map[string]struct {
		spec    qt.AggSpec
		message string
	}{
		"group budget": {qt.AggSpec{ID: "middle", Expression: "SUM([n])", GroupBy: []string{"flag"}}, "group population exceeds host budget"},
		"invalid input": {qt.AggSpec{ID: "middle", Expression: "SUM([text])"}, "numeric aggregate requires numeric input"},
	} {
		t.Run(name, func(t *testing.T) {
			metrics := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Limit: 10, Metrics: []qt.AggSpec{{ID: "sum", Expression: "SUM([n])"}, middle.spec, {ID: "count", Expression: "COUNT()"}}}
			r, err := d.ExecuteV2(context.Background(), db, &rows, &metrics, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if len(r.Rows.Rows) != 4 {
				t.Fatal(r.Rows)
			}
			assertMiddleMetricFailed(t, r.Metrics.Metrics, 12, 4, middle.message)
		})
	}
	// Request-level failures still fail the request.
	metrics := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{{ID: "sum", Expression: "SUM([n])"}, {ID: "sum", Expression: "COUNT()"}}}
	var diag *qt.PlanDiagnostic
	if _, err := d.ExecuteV2(context.Background(), db, nil, &metrics, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "duplicate_metric" {
		t.Fatalf("duplicate IDs: %v", err)
	}
	metrics = qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{{ID: "sum", Expression: "SUM([n])", Scope: "visible"}}}
	if _, err := d.ExecuteV2(context.Background(), db, nil, &metrics, qt.PlanOptions{}); err == nil {
		t.Fatal("bad scope accepted")
	}
}

func TestV3MiddleMetricSampleBudgetIsIsolated(t *testing.T) {
	db, d := setupV3(t)
	d.MaxSamplesPerGroup = 2
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}, {ID: "middle", Expression: "MEDIAN([n])", GroupBy: []string{"k"}}, {ID: "count", Op: "count"}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Rows) != 6 {
		t.Fatal(out.Rows)
	}
	assertMiddleMetricFailed(t, out.Metrics, 23, 6, "MEDIAN exceeded the 2-sample budget for one or more groups")
	// Grouped summaries share the grouping stage with rows, so their budget
	// remains a request failure, with the same readable message.
	var diag *qt.PlanDiagnostic
	if _, err = d.Execute(context.Background(), db, groupedRequest(), qt.PlanOptions{}); !errors.As(err, &diag) || diag.Message != "Summary median: MEDIAN exceeded the 2-sample budget for one or more groups" {
		t.Fatalf("summary budget: %v", err)
	}
}
