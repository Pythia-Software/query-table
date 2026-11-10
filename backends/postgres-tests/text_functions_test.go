package postgrestests

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// The shared fixture is executed by every engine; see
// schema/fixtures/text-functions.json.
type textFunctionCase struct {
	Name      string         `json:"name"`
	OrderBy   []qt.OrderBy   `json:"orderBy"`
	Metric    qt.AggSpec     `json:"metric"`
	RefusedBy []string       `json:"refusedBy"`
	Expected  map[string]any `json:"expected"`
}
type textFunctionFixture struct {
	Now              string             `json:"now"`
	Rows             []map[string]any   `json:"rows"`
	Cases            []textFunctionCase `json:"cases"`
	GroupedSummaries struct {
		Where    []qt.WhereTerm        `json:"where"`
		Grouping qt.GroupingDefinition `json:"grouping"`
		OrderBy  []qt.OrderBy          `json:"orderBy"`
		Expected []map[string]any      `json:"expected"`
	} `json:"groupedSummaries"`
}

func setupTextFunctions(t *testing.T) (*sql.DB, qt.QueryDatasetV3, textFunctionFixture, time.Time) {
	t.Helper()
	db, d := fixture(t)
	data, err := os.ReadFile("../../schema/fixtures/text-functions.json")
	if err != nil {
		t.Fatal(err)
	}
	var f textFunctionFixture
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339Nano, f.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE messages(id text PRIMARY KEY,conversation_id text,role text,text text)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err = db.Exec("INSERT INTO messages VALUES($1,$2,$3,$4)", r["id"], r["conversation_id"], r["role"], r["text"]); err != nil {
			t.Fatal(err)
		}
	}
	fields := map[string]qt.FieldSpec{}
	for _, name := range []string{"id", "conversation_id", "role", "text"} {
		fields[name] = qt.FieldSpec{Name: name, Kind: qt.FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true}
	}
	d.Schema = qt.Schema{Name: "messages", IDField: "id", Fields: fields}
	d.SourceSQL = "SELECT * FROM messages"
	return db, d, f, now
}

func projectTextMetric(t *testing.T, metric qt.MetricResult, expected map[string]any) map[string]any {
	t.Helper()
	data, err := json.Marshal(metric)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	wantBuckets, _ := expected["buckets"].([]any)
	buckets := []any{}
	for i, item := range raw["buckets"].([]any) {
		b := item.(map[string]any)
		want := map[string]any{}
		if i < len(wantBuckets) {
			want = wantBuckets[i].(map[string]any)
		}
		p := map[string]any{"keys": b["keys"], "count": b["count"], "value": b["value"]}
		if _, ok := want["y"]; ok {
			p["y"] = b["y"]
		}
		if b["error"] != nil {
			p["error"] = true
		}
		buckets = append(buckets, p)
	}
	return map[string]any{"groupCount": raw["groupCount"], "buckets": buckets}
}

func TestPostgresTextFunctionFixture(t *testing.T) {
	db, d, f, now := setupTextFunctions(t)
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{c.Metric},
				Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{OrderBy: c.OrderBy, Limit: 100}}
			out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if slices.Contains(c.RefusedBy, "postgres") {
				// PostgreSQL's regex dialect differs from JavaScript's.
				if out.Metrics[0].ErrorCode != qt.ErrorCodeUnsupportedRegex {
					t.Fatalf("expected unsupported_regex, got %#v", out.Metrics[0])
				}
				return
			}
			if out.Metrics[0].Error != "" {
				t.Fatalf("%s: %s", out.Metrics[0].ErrorCode, out.Metrics[0].Error)
			}
			if got := projectTextMetric(t, out.Metrics[0], c.Expected); !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("got  %v\nwant %v", got, c.Expected)
			}
		})
	}
	t.Run("grouped summaries", func(t *testing.T) {
		g := f.GroupedSummaries
		selected := append([]string{}, g.Grouping.Keys...)
		for _, s := range g.Grouping.Summaries {
			selected = append(selected, s.ID)
		}
		q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: now.UnixMilli(), Rows: true, Grouping: &g.Grouping,
			Source: qt.WireQuery{Where: g.Where, Limit: 100}, Result: qt.WireQuery{Select: selected, OrderBy: g.OrderBy, Limit: 100}}
		out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(out.Rows)
		var rows []map[string]any
		if err = json.Unmarshal(data, &rows); err != nil {
			t.Fatal(err)
		}
		got := []map[string]any{}
		for _, row := range rows {
			p := map[string]any{}
			for key := range g.Expected[0] {
				p[key] = row[key]
			}
			got = append(got, p)
		}
		if !reflect.DeepEqual(got, g.Expected) {
			t.Fatalf("got  %v\nwant %v", got, g.Expected)
		}
	})
}

// The array bound, empty-separator counting and WORD_COUNT at sizes the
// fixture omits.
func TestPostgresTextFunctionBounds(t *testing.T) {
	db, d, _, now := setupTextFunctions(t)
	if _, err := db.Exec("DELETE FROM messages"); err != nil {
		t.Fatal(err)
	}
	for id, text := range map[string]string{"spaces": strings.Repeat(" ", 9999), "many": strings.Repeat(" ", 10000), "emoji": strings.Repeat("\U0001F600", 5000), "emoji2": strings.Repeat("\U0001F600", 5001), "words": strings.Repeat("w\n\u3000", 20000)} {
		if _, err := db.Exec("INSERT INTO messages VALUES($1,'c','user',$2)", id, text); err != nil {
			t.Fatal(err)
		}
	}
	for expression, want := range map[string]map[string]any{
		`SUM(ARRAY_LENGTH(SPLIT([text], " ")))`: {"spaces": 10000.0, "many": "array_range", "emoji": 1.0, "emoji2": 1.0, "words": 1.0},
		`SUM(ARRAY_LENGTH(SPLIT([text], "")))`:  {"spaces": 9999.0, "many": 10000.0, "emoji": 10000.0, "emoji2": "array_range", "words": "array_range"},
		`SUM(LENGTH(TRIM([text])))`:             {"spaces": 0.0, "many": 0.0, "emoji": 5000.0, "emoji2": 5001.0, "words": 59998.0},
		// WORD_COUNT has no array bound: 20,000 words separated by line breaks
		// and ideographic spaces.
		`SUM(WORD_COUNT([text]))`: {"spaces": 0.0, "many": 0.0, "emoji": 1.0, "emoji2": 1.0, "words": 20000.0},
	} {
		q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{{ID: "m", Op: "count", Expression: expression, GroupBy: []string{"id"}}},
			Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Limit: 100}}
		out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]any{}
		for _, b := range out.Metrics[0].Buckets {
			got[b.Keys[0].(string)] = b.Value
			if b.Error != "" {
				got[b.Keys[0].(string)] = b.Error
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v (%s)", expression, got, want, out.Metrics[0].Error)
		}
	}
}
