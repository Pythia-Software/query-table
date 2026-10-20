package querytable

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// Additional reduction outputs are expressions only: they share the primary
// spec's scope, filters and grouping, and refuse anything that needs its own.
func TestMetricOutputsShareOneScalarReduction(t *testing.T) {
	ctx := context.Background()
	o := metricOptions()
	o.SourceSQL = "SELECT * FROM fixture"
	count := AggSpec{ID: "__qt_count__", Op: "count", GroupBy: []string{"g"}}
	extra := []summaryOutput{{ID: "total", Expression: "SUM([x])"}, {ID: "ratio", Expression: "SUM([x])/COUNT([y])"}, {ID: "rows", Expression: "COUNT()"}}
	p, err := compileMetricOutputs(ctx, MetricQuery{Version: 2}, count, metricSchema(), o, true, extra)
	if err != nil {
		t.Fatal(err)
	}
	columns := map[string]OutputColumn{}
	for _, column := range p.Columns {
		columns[column.Field] = column
	}
	for i, output := range extra {
		column := columns[output.ID]
		if column.ValueAlias != fmt.Sprintf("extra%d", i) || column.ErrorAlias != column.ValueAlias+"_error" || column.Type != "number" {
			t.Fatalf("%s: %#v", output.ID, column)
		}
	}
	var diag *PlanDiagnostic
	for name, c := range map[string]struct {
		spec  AggSpec
		extra []summaryOutput
		code  string
	}{
		"sampled":      {count, []summaryOutput{{ID: "median", Expression: "MEDIAN([x])"}}, "invalid_metric"},
		"nested":       {count, []summaryOutput{{ID: "median", Expression: "SUM([x])+MEDIAN([y])"}}, "invalid_metric"},
		"distribution": {AggSpec{ID: "d", GroupBy: []string{"g"}, Distribution: &MetricDistribution{Kind: "box", Input: "[x]"}}, extra, "invalid_metric"},
		"paired":       {AggSpec{ID: "p", Expression: "SUM([x])", ExpressionY: "SUM([y])", GroupBy: []string{"g"}}, extra, "invalid_metric"},
		"row field":    {count, []summaryOutput{{ID: "bare", Expression: "[x]"}}, "aggregate_context"},
		"no aggregate": {count, []summaryOutput{{ID: "constant", Expression: "1"}}, "aggregate_required"},
	} {
		if _, err := compileMetricOutputs(ctx, MetricQuery{Version: 2}, c.spec, metricSchema(), o, true, c.extra); !errors.As(err, &diag) || diag.Code != c.code {
			t.Errorf("%s: got %v, want %s", name, err, c.code)
		}
	}
	// Field policies still apply to every output.
	s := metricSchema()
	x := s.Fields["x"]
	x.AggregateOps = []string{"sum"}
	s.Fields["x"] = x
	if _, err := compileMetricOutputs(ctx, MetricQuery{Version: 2}, count, s, o, true, []summaryOutput{{ID: "avg", Expression: "AVG([x])"}}); !errors.As(err, &diag) || diag.Code != "aggregate_disabled" {
		t.Errorf("aggregate policy: %v", err)
	}
}
