package postgrestests

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

func setupPopulation(t *testing.T) (*sql.DB, qt.QueryDatasetV3, populationFixture, time.Time) {
	t.Helper()
	db, d := fixture(t)
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
	if _, err = db.Exec(`CREATE TABLE calls(id text,kind text,status text,ms double precision,at timestamptz,session text,calls bigint)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err = db.Exec("INSERT INTO calls VALUES($1,$2,$3,$4,$5,$6,$7)", r["id"], r["kind"], r["status"], r["ms"], r["at"], r["session"], r["calls"]); err != nil {
			t.Fatal(err)
		}
	}
	yes, no := true, false
	d.Schema = qt.Schema{Name: "calls", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":      {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true, Groupable: &no},
		"kind":    {Name: "kind", Kind: qt.FieldText, Expr: "r.kind", Sortable: true, ServerFilter: true},
		"status":  {Name: "status", Kind: qt.FieldText, Expr: "r.status", Sortable: true, ServerFilter: true},
		"ms":      {Name: "ms", Kind: qt.FieldNumber, Expr: "r.ms", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
		"at":      {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", Sortable: true, ServerFilter: true, Groupable: &yes},
		"session": {Name: "session", Kind: qt.FieldText, Expr: "r.session", Sortable: true, ServerFilter: true},
		"calls":   {Name: "calls", Kind: qt.FieldNumber, Expr: "r.calls", ExpressionNumeric: true, Sortable: true, ServerFilter: true},
	}}
	d.SourceSQL = "SELECT * FROM calls"
	return db, d, f, now
}

// projectPopulation keeps only the fields the fixture states, in its JSON shape.
func projectPopulation(t *testing.T, metric any, expected map[string]any) map[string]any {
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

func TestPostgresMetricPopulationFixture(t *testing.T) {
	db, d, f, now := setupPopulation(t)
	if caps := d.Capabilities(); !caps.MetricFilters || !caps.MetricMinCount {
		t.Fatalf("capabilities: %#v", caps)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			limit := c.Limit
			if limit == 0 {
				limit = 100
			}
			q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{c.Metric},
				Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Where: c.Where, OrderBy: qt.OrderBys(c.OrderBy), Limit: limit}}
			if c.Grouping != nil {
				q.Grouping = c.Grouping
				q.Source.Where, q.Result.Where = c.Where, nil
			}
			out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if c.Expected["error"] == true {
				// A refused clause fails on its own; the request still succeeds.
				if err != nil || !strings.Contains(out.Metrics[0].Error, "minCount") {
					t.Fatalf("expected a per-metric refusal, got %#v / %v", out.Metrics, err)
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

// The optional single-statement batch decodes buckets from JSONB and reads
// hidden_groups from the envelope, including when every group is hidden.
func TestPostgresCombinedMetricPopulation(t *testing.T) {
	db, d, f, now := setupPopulation(t)
	q := qt.MetricQuery{Version: 2, Limit: 100}
	cases := []populationCase{}
	for _, c := range f.Cases {
		// Combined batches share one table window; keep the unwindowed cases.
		if c.Grouping != nil || c.Metric.DateGrouping != nil || c.Expected["error"] == true || len(c.Where) > 0 || c.Limit > 0 {
			continue
		}
		spec := c.Metric
		spec.ID = c.Name
		q.Metrics = append(q.Metrics, spec)
		cases = append(cases, c)
	}
	plan, err := qt.CompileCombinedMetrics(context.Background(), q, d.Schema, qt.PlanOptions{SourceSQL: d.SourceSQL, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(plan.SQL, plan.Args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var index, groups, hidden int64
		var raw []byte
		if err = rows.Scan(&index, &raw, &groups, &hidden); err != nil {
			t.Fatal(err)
		}
		c := cases[index]
		var buckets []map[string]any
		if err = json.Unmarshal(raw, &buckets); err != nil {
			t.Fatal(err)
		}
		metric := map[string]any{"groupCount": groups, "buckets": []any{}}
		if c.Metric.MinCount.Active() {
			metric["hiddenGroups"] = hidden
		} else if hidden != 0 {
			t.Fatalf("%s: hidden_groups without minCount", c.Name)
		}
		for _, b := range buckets {
			keys := []any{}
			for i := range c.Metric.GroupBy {
				keys = append(keys, b["group"+string(rune('0'+i))])
			}
			bucket := map[string]any{"keys": keys, "count": b["count"], "value": b["value"]}
			if dist, ok := b["distribution"]; ok {
				bucket["distribution"] = dist
			}
			metric["buckets"] = append(metric["buckets"].([]any), bucket)
		}
		if got := projectPopulation(t, metric, c.Expected); !reflect.DeepEqual(got, c.Expected) {
			t.Fatalf("%s:\ngot  %v\nwant %v", c.Name, got, c.Expected)
		}
		seen++
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen != len(cases) || seen < 5 {
		t.Fatalf("decoded %d of %d envelopes", seen, len(cases))
	}
}
