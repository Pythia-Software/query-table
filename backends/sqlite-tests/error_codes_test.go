package sqlitetests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Clients refuse queries that exceed the handshake before sending them, but
// the server must refuse them on its own: a request is never answered for a
// narrower or different population than it asks for.
func TestV3ServerEnforcesCapabilities(t *testing.T) {
	db, d := setupV3(t)
	if _, err := db.Exec(qt.SQLiteComputedColumnsDDL); err != nil {
		t.Fatal(err)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	if _, err := store.Save(context.Background(), "one", "runs", qt.SaveComputedColumnRequest{Column: qt.ComputedColumn{ID: "base", Label: "base", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}}); err != nil {
		t.Fatal(err)
	}
	if d.Capabilities().ComputedSourceFilters || d.Capabilities().RegexAggregateExpressions || d.Capabilities().Profile != qt.SQLiteExpressionProfile {
		t.Fatal("unexpected capabilities", d.Capabilities())
	}
	for _, tc := range []struct {
		name   string
		modify func(*qt.QueryRequestV3)
		code   qt.ErrorCode
		field  string
	}{
		// computedSourceFilters is false without a host allowlist.
		{"computed source filter", func(q *qt.QueryRequestV3) {
			q.ExpectedRevisions = map[string]string{"base": "1"}
			q.Source.Where = []qt.WhereTerm{{Field: "@computed/base", Op: ">=", Value: "6"}}
		}, qt.ErrorCodeFilterDisabled, "@computed/base"},
		{"profile", func(q *qt.QueryRequestV3) { q.Profile = qt.ServerExpressionProfile }, qt.ErrorCodeProfileMismatch, ""},
		{"stale revision", func(q *qt.QueryRequestV3) {
			q.ExpectedRevisions = map[string]string{"base": "7"}
			q.Result.Select = append(q.Result.Select, "@computed/base")
		}, qt.ErrorCodeDefinitionChanged, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := groupedRequest()
			tc.modify(&q)
			body, _ := json.Marshal(q)
			handler := qt.NewQueryV3Handler(db, func(*http.Request) (qt.QueryDatasetV3, qt.PlanOptions, error) { return d, qt.PlanOptions{}, nil })
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest("POST", "/query", strings.NewReader(string(body))))
			var out qt.QueryErrorBody
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Header().Get("Content-Type") != "application/json" {
				t.Fatal(w.Code, w.Body.String(), err)
			}
			if out.Error.Code != tc.code || w.Code != tc.code.HTTPStatus() || tc.field != "" && out.Error.Field != tc.field {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

// Request validation failures reachable from the v3 handler carry a code,
// never the generic internal error.
func TestV3ValidationErrorsAreCoded(t *testing.T) {
	db, d := setupV3(t)
	for name, modify := range map[string]func(*qt.QueryRequestV3){
		"unknown filter field": func(q *qt.QueryRequestV3) { q.Source.Where = []qt.WhereTerm{{Field: "nope", Op: "=", Value: "x"}} },
		"bad operator":         func(q *qt.QueryRequestV3) { q.Source.Where = []qt.WhereTerm{{Field: "k", Op: "length_gt", Value: "x"}} },
		"invalid regex": func(q *qt.QueryRequestV3) {
			q.Source.Where = []qt.WhereTerm{{Field: "k", Op: "matches_regex", Value: "("}}
		},
		"relative time": func(q *qt.QueryRequestV3) {
			q.Source.Where = []qt.WhereTerm{{Field: "at", Op: ">", Value: "-9999999999y"}}
		},
		"number":            func(q *qt.QueryRequestV3) { q.Source.Where = []qt.WhereTerm{{Field: "n", Op: ">", Value: "abc"}} },
		"unknown sort":      func(q *qt.QueryRequestV3) { q.Result.OrderBy = []qt.OrderBy{{Field: "nope", Dir: "asc"}} },
		"unknown group key": func(q *qt.QueryRequestV3) { q.Grouping.Keys = []string{"nope"} },
		"unknown summary": func(q *qt.QueryRequestV3) {
			q.Grouping.Summaries = []qt.SummaryColumn{{ID: "x", Op: "sum", Field: "nope"}}
		},
		"metric field": func(q *qt.QueryRequestV3) { q.Metrics = []qt.AggSpec{{ID: "m", Op: "sum", Field: "nope"}} },
	} {
		q := groupedRequest()
		modify(&q)
		body, _ := json.Marshal(q)
		w := httptest.NewRecorder()
		qt.NewQueryV3Handler(db, func(*http.Request) (qt.QueryDatasetV3, qt.PlanOptions, error) { return d, qt.PlanOptions{}, nil }).
			ServeHTTP(w, httptest.NewRequest("POST", "/query", strings.NewReader(string(body))))
		var out qt.QueryErrorBody
		if w.Code == 200 {
			var result qt.QueryResultV3
			if json.Unmarshal(w.Body.Bytes(), &result) == nil && len(result.Metrics) > 0 && result.Metrics[0].ErrorCode != "" && result.Metrics[0].ErrorCode != qt.ErrorCodeInternal {
				continue // isolated per metric, with a code
			}
		}
		if json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Error.Code == "" || out.Error.Code == qt.ErrorCodeInternal || w.Code != out.Error.Code.HTTPStatus() {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
}

func TestV3MetricErrorCodes(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	q.Grouping, q.Rows = nil, false
	q.Result = qt.WireQuery{Limit: 10}
	// regexAggregateExpressions is false: regex functions are refused per metric.
	q.Metrics = []qt.AggSpec{{ID: "bad", Expression: "SUM([k])"}, {ID: "ok", Op: "count"}, {ID: "regex", Expression: `SUM(REGEX_MATCH([k], "a"))`}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if out.Metrics[0].Error == "" || out.Metrics[0].ErrorCode == "" || out.Metrics[0].ErrorCode == qt.ErrorCodeInternal {
		t.Fatalf("%+v", out.Metrics[0])
	}
	if out.Metrics[2].ErrorCode != qt.ErrorCodeUnsupportedFunction {
		t.Fatalf("%+v", out.Metrics[2])
	}
	if out.Metrics[1].Error != "" || out.Metrics[1].ErrorCode != "" {
		t.Fatalf("%+v", out.Metrics[1])
	}
	raw, _ := json.Marshal(out.Metrics[0])
	if !strings.Contains(string(raw), `"errorCode":"`+string(out.Metrics[0].ErrorCode)+`"`) {
		t.Fatal(string(raw))
	}
}
