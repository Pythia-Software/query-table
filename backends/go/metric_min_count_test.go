package querytable

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestMetricMinCountJSON(t *testing.T) {
	for raw, want := range map[string]MetricMinCount{
		`3`:                         {Min: 3},
		`{"min":5,"distinct":"g"}`:  {Min: 5, Distinct: "g"},
		`{"sum":"x","min":10}`:      {Min: 10, Sum: "x"},
		`null`:                      {},
		`2.0`:                       {Min: 2},
		`{"min":-1,"distinct":"g"}`: {Min: -1, Distinct: "g"},
	} {
		var spec AggSpec
		if err := json.Unmarshal([]byte(`{"id":"m","op":"count","minCount":`+raw+`}`), &spec); err != nil || spec.MinCount != want {
			t.Errorf("%s: %+v, %v", raw, spec.MinCount, err)
		}
	}
	for _, raw := range []string{`2.5`, `"3"`, `[3]`, `{"min":3}`, `{"min":3,"distinct":"g","sum":"x"}`, `{"distinct":"g"}`,
		`{"min":3,"distinct":""}`, `{"min":3,"sum":"x","extra":1}`, `{"min":2.5,"sum":"x"}`, `1e300`} {
		var spec AggSpec
		if err := json.Unmarshal([]byte(`{"id":"m","op":"count","minCount":`+raw+`}`), &spec); err == nil {
			t.Errorf("%s accepted as %+v", raw, spec.MinCount)
		}
	}
	for want, spec := range map[string]AggSpec{
		`{"id":"m","op":"count"}`:                                     {ID: "m", Op: "count"},
		`{"id":"m","op":"count","minCount":4}`:                        {ID: "m", Op: "count", MinCount: MetricMinCount{Min: 4}},
		`{"id":"m","op":"count","minCount":{"min":5,"distinct":"g"}}`: {ID: "m", Op: "count", MinCount: MetricMinCount{Min: 5, Distinct: "g"}},
		`{"id":"m","op":"count","minCount":{"min":10,"sum":"x"}}`:     {ID: "m", Op: "count", MinCount: MetricMinCount{Min: 10, Sum: "x"}},
	} {
		if got, err := json.Marshal(spec); err != nil || string(got) != want {
			t.Errorf("marshal %+v: %s, %v", spec, got, err)
		}
	}
	for name, m := range map[string]MetricMinCount{
		"no min":   {Distinct: "g"},
		"both":     {Min: 2, Distinct: "g", Sum: "x"},
		"too many": {Min: MaxMetricMinCount + 1, Sum: "x"},
		"long":     {Min: 2, Sum: strings.Repeat("f", 257)},
	} {
		if err := (WireQuery{Aggregations: []AggSpec{{ID: "m", Op: "count", GroupBy: []string{"g"}, MinCount: m}}}).Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestMetricMinCountMeasurePlans(t *testing.T) {
	compile := func(spec AggSpec) (SQLPlan, error) {
		spec.ID = "m"
		p, err := CompileMetrics(context.Background(), MetricQuery{Version: 2, Limit: 1, Metrics: []AggSpec{spec}}, metricSchema(), metricOptions())
		if err != nil {
			return SQLPlan{}, err
		}
		return p.Metrics[0].SQLPlan, nil
	}
	code := func(err error) string {
		var d *PlanDiagnostic
		if errors.As(err, &d) {
			return d.Code
		}
		return ""
	}
	for name, c := range map[string]struct {
		spec AggSpec
		code string
	}{
		"text sum":     {AggSpec{Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Sum: "g"}}, "type_error"},
		"unknown":      {AggSpec{Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Distinct: "missing"}}, "min_count_field"},
		"computed":     {AggSpec{Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Distinct: "@computed/c"}}, "min_count_field"},
		"distribution": {AggSpec{Op: "count", GroupBy: []string{"g"}, Distribution: &MetricDistribution{Kind: "box", Input: "[x]"}, MinCount: MetricMinCount{Min: 2, Sum: "x"}}, "min_count_distribution"},
		"ungrouped":    {AggSpec{Op: "count", MinCount: MetricMinCount{Min: 2, Sum: "x"}}, "min_count_grouping"},
	} {
		if _, err := compile(c.spec); code(err) != c.code {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A restricted field refuses the aggregate the minimum needs.
	s := metricSchema()
	x := s.Fields["x"]
	x.AggregateOps = []string{"count"}
	s.Fields["x"] = x
	if _, err := CompileMetrics(context.Background(), MetricQuery{Version: 2, Limit: 1, Metrics: []AggSpec{{ID: "m", Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Sum: "x"}}}}, s, metricOptions()); err == nil {
		t.Fatal("restricted SUM accepted for a minimum")
	}
	rows, err := compile(AggSpec{Op: "sum", Field: "x", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2}})
	if err != nil {
		t.Fatal(err)
	}
	summed, err := compile(AggSpec{Op: "sum", Field: "x", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Sum: "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summed.SQL, "min_measure") || strings.Contains(rows.SQL, "min_measure") || rows.Fingerprint == summed.Fingerprint {
		t.Fatalf("summed minimum plan: %s", summed.SQL)
	}
	// The minimum shares the metric's own SUM reduction.
	if a, b := strings.Count(rows.SQL, "SUM(abs("), strings.Count(summed.SQL, "SUM(abs("); a != b {
		t.Fatalf("SUM reductions: rows %d, summed %d", a, b)
	}
	distinct, err := compile(AggSpec{Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Distinct: "y"}})
	if err != nil || !strings.Contains(distinct.SQL, "COUNT(DISTINCT") {
		t.Fatalf("distinct minimum plan: %v", err)
	}
	if _, err = CompileSQLiteMetrics(context.Background(), MetricQuery{Version: 2, Limit: 1, Metrics: []AggSpec{{ID: "m", Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Sum: "x"}}}}, metricSchema(), metricOptions()); err != nil {
		t.Fatal(err)
	}
	// V1 never drops a measured minimum.
	if _, err = CompileAggregation(AggSpec{ID: "m", Op: "count", GroupBy: []string{"g"}, MinCount: MetricMinCount{Min: 2, Sum: "x"}}, metricSchema()); err == nil {
		t.Fatal("v1 accepted a measured minimum")
	}
}

func TestMetricMinCountKeeps(t *testing.T) {
	rows, distinct := MetricMinCount{Min: 3}, MetricMinCount{Min: 3, Distinct: "g"}
	for _, c := range []struct {
		m       MetricMinCount
		count   int64
		measure any
		err     bool
		keep    bool
	}{
		{rows, 3, nil, false, true},
		{rows, 2, nil, false, false},
		{rows, 0, nil, false, true},
		{distinct, 40, 2.0, false, false},
		{distinct, 1, int64(3), false, true},
		{distinct, 5, nil, false, false},
		{distinct, 5, nil, true, true},
		{distinct, 0, nil, false, true},
		{distinct, 5, []byte("3.5"), false, true},
		{MetricMinCount{}, 1, nil, false, true},
	} {
		if got := c.m.keeps(c.count, c.measure, c.err); got != c.keep {
			t.Errorf("%+v count %d measure %v error %v: %v", c.m, c.count, c.measure, c.err, got)
		}
	}
}
