package sqlitetests

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Host source bindings may be expensive or volatile. Cheap projections may be
// inlined, but never over a host binding that is not yet stored: adding
// consumers or aggregates of a field must not evaluate its binding again.
func TestV2InlineProjectionsKeepHostInputsShared(t *testing.T) {
	db, d := setupReuse(t) // n is bound to a counted host function
	probe := func(q qt.MetricQuery) int64 {
		t.Helper()
		metricProbeCalls.Store(0)
		r, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range r.Metrics.Metrics {
			if m.Error != "" {
				t.Fatal(m.ID, m.Error)
			}
		}
		return metricProbeCalls.Load()
	}
	for _, shape := range []struct {
		name   string
		modify func(*qt.MetricQuery)
	}{
		{"all rows", func(*qt.MetricQuery) {}},
		{"grouped", func(q *qt.MetricQuery) { q.Metrics[0].GroupBy = []string{"flag"} }},
		{"shown rows", func(q *qt.MetricQuery) { q.Metrics[0].Scope, q.Limit = "shownRows", 2 }},
	} {
		t.Run(shape.name, func(t *testing.T) {
			q := metricV2("SUM([n])")
			shape.modify(&q)
			once := probe(q)
			for _, expression := range []string{
				"SUM([n])+AVG([n])+MIN([n])+MAX([n])+COUNT([n])+COUNT_DISTINCT([n])",
				"SUM(IF([n]>2,[n],0))+COUNT(COALESCE([n],0))+MAX(IF([n]=4,NULL,[n]))",
				"SUM(IF(IF([n]>2,[n]<6,FALSE) AND NOT IS_NULL([n]),[n],0))",
			} {
				q.Metrics[0].Expression = expression
				if calls := probe(q); calls != once || once == 0 {
					t.Fatalf("%s evaluated the host binding %d times; one consumer evaluates it %d times", expression, calls, once)
				}
			}
			// A fused batch of metrics over the same input shares it as well.
			batch := q
			batch.Metrics = nil
			for i, expression := range []string{"SUM([n])", "AVG([n])", "MIN([n])", "MAX([n])"} {
				spec := q.Metrics[0]
				spec.ID, spec.Expression = fmt.Sprint("m", i), expression
				batch.Metrics = append(batch.Metrics, spec)
			}
			if calls := probe(batch); calls != once {
				t.Fatalf("batch evaluated the host binding %d times; one consumer evaluates it %d times", calls, once)
			}
		})
	}
	// Datetime decoding stays shared too.
	decodes := func(expression string) int64 {
		before := sqliteCalls["qt_v2_datetime"].Load()
		probe(metricV2(expression))
		return sqliteCalls["qt_v2_datetime"].Load() - before
	}
	if once, many := decodes("MIN([stamp])"), decodes("COUNT(IF(IS_NULL([stamp]),NULL,[stamp]))+COUNT([stamp])+COUNT(COALESCE([stamp],NULL))"); once == 0 || many != once {
		t.Fatalf("datetime decoded %d times for several consumers, %d for one", many, once)
	}
}

func TestV3InlineProjectionsKeepHostInputsShared(t *testing.T) {
	db, d := setupV3(t)
	d.SourceSQL = "SELECT *, qt_test_metric_probe(n) AS sample_n FROM grouped"
	n := d.Schema.Fields["n"]
	n.Expr = "r.sample_n"
	d.Schema.Fields["n"] = n
	probe := func(summaries ...qt.SummaryColumn) int64 {
		t.Helper()
		q := groupedRequest()
		q.Grouping.Summaries = summaries
		q.Result = qt.WireQuery{Select: []string{"k"}, Limit: 10}
		metricProbeCalls.Store(0)
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
			t.Fatal(err)
		}
		return metricProbeCalls.Load()
	}
	once := probe(qt.SummaryColumn{ID: "total", Op: "sum", Field: "n"})
	many := probe(qt.SummaryColumn{ID: "total", Op: "sum", Field: "n"}, qt.SummaryColumn{ID: "average", Op: "avg", Field: "n"},
		qt.SummaryColumn{ID: "low", Op: "min", Field: "n"}, qt.SummaryColumn{ID: "high", Op: "max", Field: "n"},
		qt.SummaryColumn{ID: "share", Op: "formula", Expression: "SUM(IF([n]>2,[n],0))/COUNT()"})
	// Staging evaluates the binding; group reductions read the staged copy.
	if once == 0 || many != once {
		t.Fatalf("host binding evaluated %d times for five summaries, %d for one", many, once)
	}
}

// Long chains of cheap projections stay correct: inlining stops at the read
// budget and materializes, rather than growing the SQL exponentially.
func TestInlinedFormulaChainsKeepValuesAndErrors(t *testing.T) {
	db, d := setupV2(t)
	nested, lazy := "[n]", "[n]"
	for i := 0; i < 12; i++ {
		nested = fmt.Sprintf("COALESCE(IF([n]>%d,%s,NULL),0)", -i-1, nested)
		lazy = fmt.Sprintf("IF(%s>%d,%s,1/0)", "[n]", 3+i%2, lazy)
	}
	// n is 2, 4, NULL and 6 within the tenant.
	for _, c := range []struct {
		expression string
		value      any
		code       string
	}{
		{"SUM(" + nested + ")", float64(12), ""},
		{"MAX(" + nested + ")+MIN(" + nested + ")", float64(6), ""},
		{"SUM(" + lazy + ")", nil, "divide_by_zero"},
		{"IF(TRUE,SUM([n]),SUM(" + lazy + "))", float64(12), ""},
		{"COUNT(IF([n]>3," + nested + ",NULL))", float64(2), ""},
	} {
		m := runMetric(t, db, d, metricV2(c.expression))
		if c.code != "" {
			if len(m.Buckets) != 1 || m.Buckets[0].Error != c.code {
				t.Fatalf("%.60s: %#v", c.expression, m)
			}
			continue
		}
		if m.Error != "" || len(m.Buckets) != 1 || !reflect.DeepEqual(m.Buckets[0].Value, c.value) {
			t.Fatalf("%.60s: %#v", c.expression, m)
		}
	}
	// The same chains as computed row values, with per-value errors.
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		source := nested
		if id == "lazy" {
			source = lazy
		}
		return qt.ComputedColumn{ID: id, Label: id, Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: source}}, nil
	})}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, ExpectedRevisions: map[string]string{"nested": "1", "lazy": "1"},
		WireQuery: qt.WireQuery{Select: []string{"id", "@computed/nested", "@computed/lazy"}, OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}, Limit: 10}}
	r, err := d.ExecuteV2(context.Background(), db, &q, nil, o)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []struct {
		nested any
		lazy   string
	}{{float64(2), "divide_by_zero"}, {float64(4), "divide_by_zero"}, {float64(0), "divide_by_zero"}, {float64(6), ""}} {
		values := r.Rows.Computed[i].Values
		lazyCode := ""
		if values["lazy"].Error != nil {
			lazyCode = values["lazy"].Error.Code
		}
		if !reflect.DeepEqual(values["nested"].Value, want.nested) || lazyCode != want.lazy {
			t.Fatalf("row %d: %#v", i, values)
		}
	}
}
