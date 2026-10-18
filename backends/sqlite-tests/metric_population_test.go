package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// The shared fixture is executed by every engine; see
// schema/fixtures/metric-population.json.
type populationCase struct {
	Name     string                 `json:"name"`
	Where    []qt.WhereTerm         `json:"where"`
	OrderBy  []qt.OrderBy           `json:"orderBy"`
	Limit    int                    `json:"limit"`
	Grouping *qt.GroupingDefinition `json:"grouping"`
	Metric   qt.AggSpec             `json:"metric"`
	Expected map[string]any         `json:"expected"`
}
type populationFixture struct {
	Now   string           `json:"now"`
	Rows  []map[string]any `json:"rows"`
	Cases []populationCase `json:"cases"`
}

func loadPopulationFixture(t *testing.T) (populationFixture, time.Time) {
	t.Helper()
	data, err := os.ReadFile("../../schema/fixtures/metric-population.json")
	if err != nil {
		t.Fatal(err)
	}
	var f populationFixture
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, f.Now)
	if err != nil {
		t.Fatal(err)
	}
	return f, now
}

// projectPopulation keeps only the fields the fixture states, in its JSON shape.
func projectPopulation(t *testing.T, metric qt.SQLiteMetricV2, expected map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(metric)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	out := map[string]any{"groupCount": raw["groupCount"]}
	if hidden, ok := raw["hiddenGroups"]; ok {
		out["hiddenGroups"] = hidden
	}
	if _, ok := expected["processedRows"]; ok {
		out["processedRows"] = raw["processedRows"]
	}
	wantBuckets, _ := expected["buckets"].([]any)
	buckets := []any{}
	for i, item := range raw["buckets"].([]any) {
		b := item.(map[string]any)
		want := map[string]any{}
		if i < len(wantBuckets) {
			want = wantBuckets[i].(map[string]any)
		}
		p := map[string]any{"keys": b["keys"], "count": b["count"]}
		if _, ok := want["value"]; ok {
			p["value"] = b["value"]
		}
		d, _ := b["distribution"].(map[string]any)
		if _, ok := want["box"]; ok && d != nil {
			if s, ok := d["summary"].(map[string]any); ok {
				p["box"] = map[string]any{"n": s["n"], "min": s["min"], "q1": s["q1"], "median": s["median"], "q3": s["q3"], "max": s["max"]}
			}
		}
		if _, ok := want["histogram"]; ok && d != nil {
			p["histogram"] = map[string]any{"edges": d["edges"], "counts": d["counts"], "n": d["n"]}
		}
		buckets = append(buckets, p)
	}
	out["buckets"] = buckets
	return out
}

func populationRequest(c populationCase, profile string, now time.Time) qt.QueryRequestV3 {
	limit := c.Limit
	if limit == 0 {
		limit = 100
	}
	q := qt.QueryRequestV3{Version: 3, Profile: profile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{c.Metric},
		Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Where: c.Where, OrderBy: qt.OrderBys(c.OrderBy), Limit: limit}}
	if c.Grouping != nil {
		q.Grouping = c.Grouping
		q.Source.Where, q.Result.Where = c.Where, nil
	}
	return q
}

func populationSchema(sqlite bool) qt.Schema {
	yes, no := true, false
	at := qt.FieldSpec{Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", Sortable: true, ServerFilter: true, Groupable: &yes}
	if sqlite {
		at.SQLiteDatetimeFormat = "utc-millis"
	}
	return qt.Schema{Name: "calls", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":     {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true, Groupable: &no},
		"kind":   {Name: "kind", Kind: qt.FieldText, Expr: "r.kind", Sortable: true, ServerFilter: true},
		"status": {Name: "status", Kind: qt.FieldText, Expr: "r.status", Sortable: true, ServerFilter: true},
		"ms":     {Name: "ms", Kind: qt.FieldNumber, Expr: "r.ms", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"at":     at,
	}}
}

func setupPopulation(t *testing.T) (*sql.DB, populationFixture, time.Time) {
	db, _ := setup(t)
	f, now := loadPopulationFixture(t)
	if _, err := db.Exec(`CREATE TABLE calls(id TEXT,kind TEXT,status TEXT,ms REAL,at TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err := db.Exec("INSERT INTO calls VALUES(?,?,?,?,?)", r["id"], r["kind"], r["status"], r["ms"], r["at"]); err != nil {
			t.Fatal(err)
		}
	}
	return db, f, now
}

func TestMetricPopulationFixtureV3(t *testing.T) {
	db, f, now := setupPopulation(t)
	d := qt.QueryDatasetV3{Schema: populationSchema(true), SourceSQL: "SELECT * FROM calls", Dialect: "sqlite", Scope: "one", Dataset: "calls"}
	if caps := d.Capabilities(); !caps.MetricFilters || !caps.MetricMinCount {
		t.Fatalf("capabilities: %#v", caps)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			out, err := d.Execute(context.Background(), db, populationRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
			if c.Expected["error"] == true {
				if err == nil {
					t.Fatalf("expected a refusal, got %#v", out.Metrics)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := projectPopulation(t, out.Metrics[0], c.Expected); !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("got  %v\nwant %v", got, c.Expected)
			}
		})
	}
}

func TestMetricPopulationFixtureV2(t *testing.T) {
	db, f, now := setupPopulation(t)
	d := qt.SQLiteV2Dataset{Schema: populationSchema(true), SourceSQL: "SELECT * FROM calls", Scope: "one", Dataset: "calls"}
	if caps := d.Capabilities(); !caps.Filters || !caps.MinCount {
		t.Fatalf("capabilities: %#v", caps)
	}
	for _, c := range f.Cases {
		if c.Grouping != nil || c.Metric.DateGrouping != nil {
			continue // v3-only stages
		}
		t.Run(c.Name, func(t *testing.T) {
			limit := c.Limit
			if limit == 0 {
				limit = 100
			}
			q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Where: c.Where, OrderBy: c.OrderBy, Limit: limit, Metrics: []qt.AggSpec{c.Metric}}
			out, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{Now: now})
			if c.Expected["error"] == true {
				var diag *qt.PlanDiagnostic
				if err == nil || !strings.Contains(err.Error(), "minCount") {
					t.Fatalf("expected a minCount diagnostic, got %v / %v", err, diag)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := projectPopulation(t, out.Metrics.Metrics[0], c.Expected); !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("got  %v\nwant %v", got, c.Expected)
			}
		})
	}
}

// Metrics with the same grouping but different predicates must never share a
// cached or fused reduction; identical ones still may.
func TestMetricPopulationReductionReuseKeys(t *testing.T) {
	db, _, now := setupPopulation(t)
	d := qt.SQLiteV2Dataset{Schema: populationSchema(true), SourceSQL: "SELECT * FROM calls", Scope: "one", Dataset: "calls"}
	errors := []qt.WhereTerm{{Field: "status", Op: "=", Value: "error"}}
	ok := []qt.WhereTerm{{Field: "status", Op: "=", Value: "ok"}}
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Limit: 100, Metrics: []qt.AggSpec{
		{ID: "all", Op: "count", GroupBy: []string{"kind"}},
		{ID: "errors", Op: "count", GroupBy: []string{"kind"}, Where: errors},
		{ID: "ok", Op: "count", GroupBy: []string{"kind"}, Where: ok},
		{ID: "error_ms", Op: "sum", Field: "ms", GroupBy: []string{"kind"}, Where: errors},
		{ID: "errors_again", Op: "count", GroupBy: []string{"kind"}, Where: errors},
		{ID: "errors_min", Op: "count", GroupBy: []string{"kind"}, Where: errors, MinCount: 2},
	}}
	out, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	summary := map[string]map[string]any{}
	for _, m := range out.Metrics.Metrics {
		groups := map[string]any{}
		for _, b := range m.Buckets {
			key := "<null>"
			if b.Keys[0] != nil {
				key = b.Keys[0].(string)
			}
			groups[key] = b.Value
		}
		summary[m.ID] = groups
	}
	want := map[string]map[string]any{
		"all":          {"timeout": 6.0, "auth": 4.0, "disk": 2.0, "dns": 1.0, "<null>": 1.0},
		"errors":       {"timeout": 4.0, "auth": 2.0, "disk": 1.0, "dns": 1.0, "<null>": 1.0},
		"ok":           {"timeout": 1.0, "auth": 2.0, "disk": 1.0},
		"error_ms":     {"timeout": 920.0, "auth": 120.0, "disk": 33.0, "dns": 999.0, "<null>": 60.0},
		"errors_again": {"timeout": 4.0, "auth": 2.0, "disk": 1.0, "dns": 1.0, "<null>": 1.0},
		"errors_min":   {"timeout": 4.0, "auth": 2.0},
	}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("got  %v\nwant %v", summary, want)
	}
	if h := out.Metrics.Metrics[5].HiddenGroups; h == nil || *h != 3 {
		t.Fatalf("hidden groups: %v", h)
	}
	if out.Metrics.Metrics[1].HiddenGroups != nil {
		t.Fatal("hiddenGroups must be absent without minCount")
	}
}
