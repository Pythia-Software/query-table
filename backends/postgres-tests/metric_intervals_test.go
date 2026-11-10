package postgrestests

import (
	"context"
	"database/sql"
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
	Name     string         `json:"name"`
	Planned  bool           `json:"planned"`
	Metric   qt.AggSpec     `json:"metric"`
	Expected map[string]any `json:"expected"`
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
		checkIntervalBucket(t, fmt.Sprint("bucket ", i), metric.Buckets[i], item.(map[string]any), near)
	}
	if want, ok := expected["other"].(map[string]any); ok {
		if metric.Other == nil {
			t.Fatalf("no Other remainder, want %v", want)
		}
		checkIntervalBucket(t, "other", *metric.Other, want, near)
	} else if metric.Other != nil {
		t.Fatalf("unexpected Other remainder %#v", *metric.Other)
	}
}

func checkIntervalBucket(t *testing.T, name string, b qt.MetricBucket, w map[string]any, near func(any, any) bool) {
	t.Helper()
	keys, _ := json.Marshal(b.Keys)
	wantKeys, _ := json.Marshal(w["keys"])
	label := fmt.Sprintf("%s %s", name, keys)
	if string(keys) != string(wantKeys) || float64(b.Count) != w["count"] {
		t.Fatalf("%s: count %d, want %v %v", label, b.Count, w["keys"], w["count"])
	}
	if w["error"] == true {
		if b.Error == "" || b.Lower != nil || b.Upper != nil {
			t.Fatalf("%s: want an error without bounds, got %#v", label, b)
		}
		return
	}
	if (b.IntervalError != "") != (w["intervalError"] == true) || (b.IntervalError != "" && b.IntervalError != "interval_domain") {
		t.Fatalf("%s: intervalError %q, want %v", label, b.IntervalError, w["intervalError"])
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

func setupIntervals(t *testing.T) (*sql.DB, qt.QueryDatasetV3, intervalFixture, time.Time) {
	t.Helper()
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
	return db, d, f, now
}

func TestPostgresMetricIntervalFixture(t *testing.T) {
	db, d, f, now := setupIntervals(t)
	if !d.Capabilities().MetricIntervals {
		t.Fatal("metricIntervals is not advertised")
	}
	for _, c := range f.Cases {
		if c.Planned {
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

// TestMetricIntervalRequests executes the requests
// metric-intervals-parity.test.ts builds with the TypeScript client
// (QT_METRIC_REQUESTS, a JSON array) over the fixture, and writes their
// results to QT_METRIC_RESULTS.
func TestMetricIntervalRequests(t *testing.T) {
	in, out := os.Getenv("QT_METRIC_REQUESTS"), os.Getenv("QT_METRIC_RESULTS")
	if in == "" || out == "" {
		t.Skip("run by metric-intervals-parity.test.ts")
	}
	db, d, _, _ := setupIntervals(t)
	data, err := os.ReadFile(in)
	if err != nil {
		t.Fatal(err)
	}
	var requests []json.RawMessage
	if err = json.Unmarshal(data, &requests); err != nil {
		t.Fatal(err)
	}
	results := []qt.QueryResultV3{}
	for _, raw := range requests {
		q, err := qt.DecodeQueryRequestV3(raw)
		if err != nil {
			t.Fatal(err)
		}
		result, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, result)
	}
	if data, err = json.Marshal(results); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(out, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
