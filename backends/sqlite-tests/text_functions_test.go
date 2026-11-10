package sqlitetests

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

func loadTextFunctionFixture(t *testing.T) (textFunctionFixture, time.Time) {
	t.Helper()
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
	return f, now
}

// projectTextMetric keeps only the fields the fixture states, in its JSON shape.
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

func textFunctionRequest(c textFunctionCase, profile string, now time.Time) qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: profile, Now: now.UnixMilli(), Metrics: []qt.AggSpec{c.Metric},
		Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{OrderBy: c.OrderBy, Limit: 100}}
}

func textFunctionGroupedRequest(f textFunctionFixture, profile string, now time.Time) qt.QueryRequestV3 {
	g := f.GroupedSummaries
	grouping := g.Grouping
	selected := append([]string{}, grouping.Keys...)
	for _, s := range grouping.Summaries {
		selected = append(selected, s.ID)
	}
	return qt.QueryRequestV3{Version: 3, Profile: profile, Now: now.UnixMilli(), Rows: true, Grouping: &grouping,
		Source: qt.WireQuery{Where: g.Where, Limit: 100}, Result: qt.WireQuery{Select: selected, OrderBy: g.OrderBy, Limit: 100}}
}

// projectTextRows keeps the selected columns of grouped rows.
func projectTextRows(t *testing.T, rows []map[string]any, expected []map[string]any) []map[string]any {
	t.Helper()
	data, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	var raw []map[string]any
	if err = json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	out := []map[string]any{}
	for _, row := range raw {
		p := map[string]any{}
		for key := range expected[0] {
			p[key] = row[key]
		}
		out = append(out, p)
	}
	return out
}

func textFunctionSchema() qt.Schema {
	fields := map[string]qt.FieldSpec{}
	for _, name := range []string{"id", "conversation_id", "role", "text"} {
		fields[name] = qt.FieldSpec{Name: name, Kind: qt.FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true}
	}
	return qt.Schema{Name: "messages", IDField: "id", Fields: fields}
}

func setupTextFunctions(t *testing.T) (*sql.DB, textFunctionFixture, time.Time) {
	db, _ := setup(t)
	f, now := loadTextFunctionFixture(t)
	if _, err := db.Exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,text TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Rows {
		if _, err := db.Exec("INSERT INTO messages VALUES(?,?,?,?)", r["id"], r["conversation_id"], r["role"], r["text"]); err != nil {
			t.Fatal(err)
		}
	}
	return db, f, now
}

func TestTextFunctionFixtureV3(t *testing.T) {
	db, f, now := setupTextFunctions(t)
	for _, d := range []qt.QueryDatasetV3{
		{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"},
		qt.TestOnlyStageUngrouped(qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}),
	} {
		for _, c := range f.Cases {
			t.Run(c.Name, func(t *testing.T) {
				out, err := d.Execute(context.Background(), db, textFunctionRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if slices.Contains(c.RefusedBy, "sqlite") {
					if out.Metrics[0].ErrorCode == "" {
						t.Fatalf("expected a refusal, got %#v", out.Metrics[0])
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
	}
	t.Run("grouped summaries", func(t *testing.T) {
		d := qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}
		out, err := d.Execute(context.Background(), db, textFunctionGroupedRequest(f, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		want := f.GroupedSummaries.Expected
		if got := projectTextRows(t, out.Rows, want); !reflect.DeepEqual(got, want) {
			t.Fatalf("got  %v\nwant %v", got, want)
		}
	})
}

// Values the shared fixture cannot carry: embedded NUL, the array and text
// result bounds, and the regex replacement errors.
func TestTextFunctionBoundsV3(t *testing.T) {
	db, _, now := setupTextFunctions(t)
	if _, err := db.Exec("DELETE FROM messages"); err != nil {
		t.Fatal(err)
	}
	rows := map[string]string{
		"nul":    "a\x00b",
		"spaces": strings.Repeat(" ", 9999),
		"many":   strings.Repeat(" ", 10000),
		"long":   strings.Repeat("o", 60000),
		"wide":   strings.Repeat("\u00e9", 50000),
	}
	for id, text := range rows {
		if _, err := db.Exec("INSERT INTO messages VALUES(?,?,?,?)", id, "c", "user", text); err != nil {
			t.Fatal(err)
		}
	}
	d := qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}
	byID := func(expression string, scope string) map[string]any {
		t.Helper()
		c := textFunctionCase{OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}, Metric: qt.AggSpec{ID: "m", Op: "count", Expression: expression, GroupBy: []string{"id"}, Scope: scope}}
		out, err := d.Execute(context.Background(), db, textFunctionRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if out.Metrics[0].Error != "" {
			t.Fatalf("%s: %s", expression, out.Metrics[0].Error)
		}
		got := map[string]any{}
		for _, b := range out.Metrics[0].Buckets {
			if b.Error != "" {
				got[b.Keys[0].(string)] = "error:" + b.Error
			} else {
				got[b.Keys[0].(string)] = b.Value
			}
		}
		return got
	}
	check := func(expression, scope string, want map[string]any) {
		t.Helper()
		if got := byID(expression, scope); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s:\ngot  %v\nwant %v", expression, got, want)
		}
	}
	// JavaScript counts an embedded NUL; SQLite's length() stops at it.
	check("SUM(LENGTH([text]))", "", map[string]any{"nul": 3.0, "spaces": 9999.0, "many": 10000.0, "long": 60000.0, "wide": 50000.0})
	check(`SUM(LENGTH(TRIM([text])))`, "", map[string]any{"nul": 3.0, "spaces": 0.0, "many": 0.0, "long": 60000.0, "wide": 50000.0})
	check(`SUM(IF(ENDS_WITH([text], "b"), 1, 0) + IF(STARTS_WITH([text], "a"), 10, 0))`, "", map[string]any{"nul": 11.0, "spaces": 0.0, "many": 0.0, "long": 0.0, "wide": 0.0})
	// More than 10,000 elements is the browser's "Array result is too large".
	check(`SUM(ARRAY_LENGTH(SPLIT([text], " ")))`, "", map[string]any{"nul": 1.0, "spaces": 10000.0, "many": "error:array_range", "long": 1.0, "wide": 1.0})
	check(`SUM(ARRAY_LENGTH(SPLIT([text], "")))`, "", map[string]any{"nul": 3.0, "spaces": 9999.0, "many": 10000.0, "long": "error:array_range", "wide": "error:array_range"})
	// Replacement output is bounded at 100,000 UTF-16 code units, exactly.
	check(`SUM(LENGTH(REGEX_REPLACE([text], "o", "$&$&")))`, "shownRows", map[string]any{"nul": 3.0, "spaces": 9999.0, "many": 10000.0, "long": "error:text_range", "wide": 50000.0})
	check(`SUM(LENGTH(REGEX_REPLACE([text], "\u00e9", "\u00e9\u00e9")))`, "shownRows", map[string]any{"nul": 3.0, "spaces": 9999.0, "many": 10000.0, "long": 60000.0, "wide": 100000.0})
	// Invalid replacement references fail only where a match occurs.
	check(`SUM(LENGTH(REGEX_REPLACE([text], "(b)", "$2")))`, "shownRows", map[string]any{"nul": "error:regex_replacement", "spaces": 9999.0, "many": 10000.0, "long": 60000.0, "wide": 50000.0})
	check(`SUM(LENGTH(REGEX_REPLACE([text], "b", "$'")))`, "shownRows", map[string]any{"nul": "error:regex_replacement", "spaces": 9999.0, "many": 10000.0, "long": 60000.0, "wide": 50000.0})
	check(`SUM(LENGTH(REGEX_EXTRACT([text], "(a)", 1.5)))`, "shownRows", map[string]any{"nul": "error:argument_range", "spaces": "error:argument_range", "many": "error:argument_range", "long": "error:argument_range", "wide": "error:argument_range"})
	check(`SUM(LENGTH(REGEX_EXTRACT([text], "(a)", 7)))`, "shownRows", map[string]any{"nul": nil, "spaces": nil, "many": nil, "long": nil, "wide": nil})
}

// Patterns whose JavaScript and RE2 meanings differ are refused per metric.
func TestTextFunctionRefusalsV3(t *testing.T) {
	db, _, now := setupTextFunctions(t)
	d := qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}
	for expression, code := range map[string]qt.ErrorCode{
		`SUM(LENGTH(REGEX_REPLACE([text], "a*", "-")))`:                       qt.ErrorCodeUnsupportedRegex,
		`SUM(LENGTH(REGEX_REPLACE([text], "(?<=a)b", "-")))`:                  qt.ErrorCodeUnsupportedRegex,
		`SUM(LENGTH(REGEX_REPLACE([text], "(a)\\1", "-")))`:                   qt.ErrorCodeUnsupportedRegex,
		`SUM(LENGTH(REGEX_REPLACE([text], "(?:(a)|b)+", "$1")))`:              qt.ErrorCodeUnsupportedRegex,
		`SUM(LENGTH(REGEX_REPLACE([text], "^a", "-", "m")))`:                  qt.ErrorCodeUnsupportedRegex,
		`SUM(LENGTH(REGEX_REPLACE([text], "\u00e9", "-", "i")))`:              qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "\\bs", "i"), 1, 0))`:                      qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "(?:|a)+"), 1, 0))`:                        qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "a{1001}"), 1, 0))`:                        qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "\\p{L}"), 1, 0))`:                         qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "a{"), 1, 0))`:                             qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], "a", "g"), 1, 0))`:                         qt.ErrorCodeUnsupportedRegex,
		`SUM(IF(REGEX_TEST([text], [role]), 1, 0))`:                           qt.ErrorCodeUnsupportedRegex,
		`IF(REGEX_TEST(MAX([text]), "a"), 1, 0)`:                              qt.ErrorCodeAggregateContext,
		`SUM(IF(CONTAINS([text], "a", 1), 1, 0))`:                             qt.ErrorCodeTypeError,
		`SUM(LENGTH(LEFT([text], 1)))`:                                        qt.ErrorCodeUnsupportedFunction,
		`COUNT(SPLIT([text], " "))`:                                           qt.ErrorCodeUnsupportedType,
		`SUM(ARRAY_LENGTH(IF(TRUE, SPLIT([text], " "), SPLIT([text], ","))))`: qt.ErrorCodeUnsupportedType,
		`SUM(ARRAY_LENGTH([text]))`:                                           qt.ErrorCodeTypeError,
		`SUM(ARRAY_LENGTH(SPLIT([text])))`:                                    qt.ErrorCodeArity,
		`IF(TRUE, SPLIT(MAX([text]), " "), SPLIT(MAX([text]), ","))`:          qt.ErrorCodeUnsupportedType,
		`SPLIT(MAX([text]), " ")`:                                             qt.ErrorCodeUnsupportedType,
		`SUM(LENGTH([text], 1))`:                                              qt.ErrorCodeArity,
		`SUM(WORD_COUNT([text], " "))`:                                        qt.ErrorCodeArity,
	} {
		c := textFunctionCase{Metric: qt.AggSpec{ID: "m", Op: "count", Expression: expression, Scope: "shownRows"}, OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}}
		out, err := d.Execute(context.Background(), db, textFunctionRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if out.Metrics[0].ErrorCode != code {
			t.Errorf("%s: got %q (%s), want %q", expression, out.Metrics[0].ErrorCode, out.Metrics[0].Error, code)
		}
	}
}

// WORD_COUNT has no array bound, unlike ARRAY_LENGTH(SPLIT(...)), and the
// split count also compiles outside an aggregate.
func TestTextWordCountV3(t *testing.T) {
	db, _, now := setupTextFunctions(t)
	if _, err := db.Exec("DELETE FROM messages"); err != nil {
		t.Fatal(err)
	}
	rows := map[string]string{"words": strings.Repeat("w\n\u3000", 20000), "nul": "a\x00b c", "mixed": " a\tb\u00a0c\u2028d\u0085e "}
	for id, text := range rows {
		if _, err := db.Exec("INSERT INTO messages VALUES(?,?,?,?)", id, "c", "user", text); err != nil {
			t.Fatal(err)
		}
	}
	d := qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}
	for expression, want := range map[string]map[string]any{
		"SUM(WORD_COUNT([text]))":                 {"words": 20000.0, "nul": 2.0, "mixed": 4.0},
		`SUM(ARRAY_LENGTH(SPLIT([text], " ")))`:   {"words": 1.0, "nul": 2.0, "mixed": 3.0},
		`ARRAY_LENGTH(SPLIT(MAX([text]), "\n"))`:  {"words": "array_range", "nul": 1.0, "mixed": 1.0},
		`ARRAY_LENGTH(SPLIT(MAX([text]), "\t"))`:  {"words": 1.0, "nul": 1.0, "mixed": 2.0},
		`SUM(ARRAY_LENGTH(SPLIT([text], "\n")))`:  {"words": "array_range", "nul": 1.0, "mixed": 1.0},
		"WORD_COUNT(MAX([text])) - COUNT([text])": {"words": 19999.0, "nul": 1.0, "mixed": 3.0},
	} {
		c := textFunctionCase{Metric: qt.AggSpec{ID: "m", Op: "count", Expression: expression, GroupBy: []string{"id"}}}
		out, err := d.Execute(context.Background(), db, textFunctionRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
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
			t.Errorf("%s:\ngot  %v\nwant %v (%s)", expression, got, want, out.Metrics[0].Error)
		}
	}
}

// LOWER, UPPER and ignoreCase use Go's simple Unicode case mapping, not
// JavaScript's full, context-sensitive one. These are the documented
// differences (docs/backend-metrics.md); the shared fixture keeps to letters
// every engine maps alike.
func TestTextCaseMappingV3(t *testing.T) {
	db, _, now := setupTextFunctions(t)
	if _, err := db.Exec("DELETE FROM messages"); err != nil {
		t.Fatal(err)
	}
	rows := map[string]string{"sharp": "straße", "sigma": "ΟΔΟΣ", "dotted": "İ", "dotless": "ı", "nul": "a\x00B"}
	for id, text := range rows {
		if _, err := db.Exec("INSERT INTO messages VALUES(?,?,?,?)", id, "c", "user", text); err != nil {
			t.Fatal(err)
		}
	}
	d := qt.QueryDatasetV3{Schema: textFunctionSchema(), SourceSQL: "SELECT * FROM messages", Dialect: "sqlite", Scope: "one", Dataset: "messages"}
	for expression, want := range map[string]map[string]any{
		// JavaScript: "STRASSE", "ΟΔΟΣ", "İ", "I".
		"MAX(UPPER([text]))": {"sharp": "STRAßE", "sigma": "ΟΔΟΣ", "dotted": "İ", "dotless": "I", "nul": "A\x00B"},
		// JavaScript: "straße", "οδος" (final sigma), "i̇" (i and U+0307), "ı".
		"MAX(LOWER([text]))": {"sharp": "straße", "sigma": "οδοσ", "dotted": "i", "dotless": "ı", "nul": "a\x00b"},
		// JavaScript: false for "dotted", whose lower case ends with U+0307.
		`SUM(IF(ENDS_WITH([text], "i", TRUE), 1, 0))`: {"sharp": 0.0, "sigma": 0.0, "dotted": 1.0, "dotless": 0.0, "nul": 0.0},
	} {
		c := textFunctionCase{Metric: qt.AggSpec{ID: "m", Op: "count", Expression: expression, GroupBy: []string{"id"}}}
		out, err := d.Execute(context.Background(), db, textFunctionRequest(c, qt.SQLiteExpressionProfile, now), qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]any{}
		for _, b := range out.Metrics[0].Buckets {
			got[b.Keys[0].(string)] = b.Value
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\ngot  %q\nwant %q (%s)", expression, got, want, out.Metrics[0].Error)
		}
	}
}
