package postgrestests

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// The shared fixture is executed by every engine; see
// schema/fixtures/metric-intervals.json and the SQLite twin of this test.
type intervalCase struct {
	Name      string         `json:"name"`
	LocalOnly bool           `json:"localOnly"`
	Metric    qt.AggSpec     `json:"metric"`
	Expected  map[string]any `json:"expected"`
}
type intervalFixture struct {
	Now       string           `json:"now"`
	Tolerance float64          `json:"tolerance"`
	Rows      []map[string]any `json:"rows"`
	Cases     []intervalCase   `json:"cases"`
}

func checkIntervalMetric(t *testing.T, metric qt.MetricResult, expected map[string]any, tolerance float64) {
	t.Helper()
	if expected["error"] == true {
		if metric.ErrorCode != qt.ErrorCodeMetricInterval {
			t.Fatalf("expected a metric_interval error, got %#v", metric)
		}
		return
	}
	if metric.Error != "" {
		t.Fatalf("metric error %s: %s", metric.ErrorCode, metric.Error)
	}
	if float64(metric.GroupCount) != expected["groupCount"] {
		t.Fatalf("groupCount %d, want %v", metric.GroupCount, expected["groupCount"])
	}
	if want, ok := expected["hiddenGroups"]; ok && (metric.HiddenGroups == nil || float64(*metric.HiddenGroups) != want) {
		t.Fatalf("hiddenGroups %v, want %v", metric.HiddenGroups, want)
	}
	want := expected["buckets"].([]any)
	if len(metric.Buckets) != len(want) {
		t.Fatalf("%d buckets, want %d: %#v", len(metric.Buckets), len(want), metric.Buckets)
	}
	near := func(got any, want any) bool {
		if want == nil || got == nil {
			return want == nil && got == nil
		}
		g, ok := got.(float64)
		w := want.(float64)
		return ok && math.Abs(g-w) <= tolerance*math.Max(1, math.Abs(w))
	}
	for i, item := range want {
		w, b := item.(map[string]any), metric.Buckets[i]
		keys, _ := json.Marshal(b.Keys)
		wantKeys, _ := json.Marshal(w["keys"])
		label := fmt.Sprintf("bucket %d %s", i, keys)
		if string(keys) != string(wantKeys) || float64(b.Count) != w["count"] {
			t.Fatalf("%s: count %d, want %v %v", label, b.Count, w["keys"], w["count"])
		}
		if w["error"] == true {
			if b.Error == "" || b.Lower != nil || b.Upper != nil {
				t.Fatalf("%s: want an error without bounds, got %#v", label, b)
			}
			continue
		}
		if b.Error != "" || !near(b.Value, w["value"]) {
			t.Fatalf("%s: value %v (%s), want %v", label, b.Value, b.Error, w["value"])
		}
		if _, has := w["lower"]; has != (b.Lower != nil) || has != (b.Upper != nil) {
			t.Fatalf("%s: bounds %v %v, want %v %v", label, b.Lower, b.Upper, w["lower"], w["upper"])
		}
		if b.Lower != nil && (!near(*b.Lower, w["lower"]) || !near(*b.Upper, w["upper"])) {
			t.Fatalf("%s: bounds %v–%v, want %v–%v", label, *b.Lower, *b.Upper, w["lower"], w["upper"])
		}
	}
}

func TestPostgresMetricIntervalFixture(t *testing.T) {
	db, d := fixture(t)
	data, err := os.ReadFile("../../schema/fixtures/metric-intervals.json")
	if err != nil {
		t.Fatal(err)
	}
	var f intervalFixture
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, f.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE turns(id text,band text,turn text,events bigint,messages bigint,at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err = db.Exec("INSERT INTO turns VALUES($1,$2,$3,$4,$5,$6)", r["id"], r["band"], r["turn"], r["events"], r["messages"], r["at"]); err != nil {
			t.Fatal(err)
		}
	}
	yes, no := true, false
	d.SourceSQL = "SELECT * FROM turns"
	d.Schema = qt.Schema{Name: "turns", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":       {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true, Groupable: &no},
		"band":     {Name: "band", Kind: qt.FieldText, Expr: "r.band", Sortable: true, ServerFilter: true},
		"turn":     {Name: "turn", Kind: qt.FieldText, Expr: "r.turn", Sortable: true, ServerFilter: true},
		"events":   {Name: "events", Kind: qt.FieldNumber, Expr: "r.events", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"messages": {Name: "messages", Kind: qt.FieldNumber, Expr: "r.messages", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"at":       {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", Sortable: true, ServerFilter: true, Groupable: &yes},
	}}
	if !d.Capabilities().MetricIntervals {
		t.Fatal("metricIntervals is not advertised")
	}
	for _, c := range f.Cases {
		if c.LocalOnly {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{c.Metric},
				Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Limit: 100}}
			out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			checkIntervalMetric(t, out.Metrics[0], c.Expected, f.Tolerance)
		})
	}
}
