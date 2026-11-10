package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// The shared fixture is executed by every engine; see
// schema/fixtures/metric-intervals.json.
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

func setupIntervals(t *testing.T) (*sql.DB, qt.QueryDatasetV3, intervalFixture, time.Time) {
	t.Helper()
	db, _ := setup(t)
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
	if _, err = db.Exec(`CREATE TABLE turns(id TEXT,band TEXT,turn TEXT,events INTEGER,messages INTEGER,at TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err = db.Exec("INSERT INTO turns VALUES(?,?,?,?,?,?)", r["id"], r["band"], r["turn"], r["events"], r["messages"], r["at"]); err != nil {
			t.Fatal(err)
		}
	}
	yes, no := true, false
	d := qt.QueryDatasetV3{Dialect: "sqlite", SourceSQL: "SELECT * FROM turns", Scope: "one", Dataset: "turns", Schema: qt.Schema{Name: "turns", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":       {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true, Groupable: &no},
		"band":     {Name: "band", Kind: qt.FieldText, Expr: "r.band", Sortable: true, ServerFilter: true},
		"turn":     {Name: "turn", Kind: qt.FieldText, Expr: "r.turn", Sortable: true, ServerFilter: true},
		"events":   {Name: "events", Kind: qt.FieldNumber, Expr: "r.events", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"messages": {Name: "messages", Kind: qt.FieldNumber, Expr: "r.messages", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"at":       {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", Sortable: true, ServerFilter: true, Groupable: &yes, SQLiteDatetimeFormat: "utc-millis"},
	}}}
	return db, d, f, now
}

func intervalRequest(now time.Time, metrics ...qt.AggSpec) qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: now.UnixMilli(), Metrics: metrics,
		Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Limit: 100}}
}

// checkIntervalMetric compares a result with the fixture's expectation:
// numbers within the relative tolerance, and bounds present exactly where
// the fixture has them.
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

func TestMetricIntervalFixture(t *testing.T) {
	db, d, f, now := setupIntervals(t)
	if !d.Capabilities().MetricIntervals {
		t.Fatal("metricIntervals is not advertised")
	}
	datasets := map[string]qt.QueryDatasetV3{"direct": d, "staged": qt.TestOnlyStageUngrouped(d)}
	for name, dataset := range datasets {
		for _, c := range f.Cases {
			if c.LocalOnly {
				continue
			}
			t.Run(name+"/"+c.Name, func(t *testing.T) {
				out, err := dataset.Execute(context.Background(), db, intervalRequest(now, c.Metric), qt.PlanOptions{})
				if err != nil {
					t.Fatal(err)
				}
				checkIntervalMetric(t, out.Metrics[0], c.Expected, f.Tolerance)
			})
		}
	}
}

// One batch shares reductions across metrics (cross-field fusion and plan
// reuse); a fused or reused plan must keep each metric's own bounds.
func TestMetricIntervalFixtureBatch(t *testing.T) {
	db, d, f, now := setupIntervals(t)
	metrics, expected := []qt.AggSpec{}, []map[string]any{}
	for i, c := range f.Cases {
		if c.LocalOnly || c.Metric.DateGrouping != nil {
			continue
		}
		metric := c.Metric
		metric.ID = fmt.Sprint("m", i)
		metrics, expected = append(metrics, metric), append(expected, c.Expected)
	}
	// The same plan at another level must not reuse the first one's bounds.
	first := f.Cases[0]
	level := 0.5
	again := first.Metric
	again.ID, again.Interval = "again", &qt.MetricInterval{Kind: "proportion", Level: &level}
	metrics = append(metrics, first.Metric, again)
	out, err := d.Execute(context.Background(), db, intervalRequest(now, metrics...), qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range expected {
		checkIntervalMetric(t, out.Metrics[i], want, f.Tolerance)
	}
	plain, narrow := out.Metrics[len(metrics)-2], out.Metrics[len(metrics)-1]
	if !reflect.DeepEqual(plain.Buckets[2].Value, narrow.Buckets[2].Value) || !(*narrow.Buckets[2].Upper < *plain.Buckets[2].Upper) {
		t.Fatalf("a 50%% interval must be narrower: %v %v", plain.Buckets[2], narrow.Buckets[2])
	}
}
