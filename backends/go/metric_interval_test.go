package querytable

import (
	"math"
	"testing"
)

func TestMetricRatioParts(t *testing.T) {
	for expression, scale := range map[string]float64{
		"SUM([events])/(COUNT_DISTINCT([turn])/1000)":                                     1000,
		"100*COUNT_DISTINCT(IF([events]>0,[turn],NULL))/NULLIF(COUNT_DISTINCT([turn]),0)": 100,
		"SUM([events])/NULLIF(COUNT()/1000,0)":                                            1000,
		"+SUM([a])/2/SUM([b])":                                                            0.5,
	} {
		n, err := parseExpression(expression)
		if err != nil {
			t.Fatal(err)
		}
		got, err := metricRatioParts(n)
		if err != nil || got.scale != scale || got.numerator == got.denominator {
			t.Fatalf("%s: %#v %v", expression, got, err)
		}
	}
	for _, expression := range []string{"SUM([events])", "AVG([e])/COUNT()", "SUM([e])-COUNT()", "-SUM([e])/COUNT()", "SUM([e])/COUNT()/COUNT()", "0*SUM([e])/COUNT()", "SUM([e])/NULLIF(COUNT(),1)"} {
		n, err := parseExpression(expression)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = metricRatioParts(n); err == nil {
			t.Fatalf("%s: accepted", expression)
		}
	}
}

// The same reference values as packages/core/test/metricIntervals.test.ts.
func TestMetricIntervalNumerics(t *testing.T) {
	near := func(got, want, tolerance float64) {
		t.Helper()
		if math.Abs(got-want) > tolerance*math.Max(1, math.Abs(want)) {
			t.Fatalf("got %.17g, want %.17g", got, want)
		}
	}
	near(normalQuantile(0.05), 1.959963984540054, 1e-14)
	near(gammaQuantile(0.975, 1), 3.6888794541139363, 1e-12)
	near(gammaQuantile(0.025, 2), 0.24220927854396496, 1e-12)
	near(gammaQuantile(0.5, 1e6), 999999.6666667, 1e-10)
	lower, upper, ok, domain := metricIntervalBounds(&MetricInterval{Kind: "proportion"}, 6, 15, 1)
	if !ok || domain {
		t.Fatal("no interval")
	}
	near(lower, 0.1982449614134158, 1e-12)
	near(upper, 0.6425316987937539, 1e-12)
	if _, upper, _, _ = metricIntervalBounds(&MetricInterval{Kind: "proportion"}, 10, 10, 1); upper != 1 {
		t.Fatalf("upper %v", upper)
	}
	if lower, _, _, _ = metricIntervalBounds(&MetricInterval{Kind: "proportion"}, 0, 10, 1); lower != 0 {
		t.Fatalf("lower %v", lower)
	}
	if _, _, _, domain = metricIntervalBounds(&MetricInterval{Kind: "proportion"}, 11, 10, 1); !domain {
		t.Fatal("11 of 10 is outside a proportion's domain")
	}
	if _, _, ok, _ = metricIntervalBounds(&MetricInterval{Kind: "rate"}, 3, 0, 1); ok {
		t.Fatal("a zero exposure has no interval")
	}
}
