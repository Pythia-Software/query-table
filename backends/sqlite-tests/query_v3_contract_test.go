package sqlitetests

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestV3HTTPAuthorizationAndStrictRequests(t *testing.T) {
	db, d := setupV3(t)
	body, err := json.Marshal(groupedRequest())
	if err != nil {
		t.Fatal(err)
	}
	invoke := func(handler http.Handler, method, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(method, "/query", strings.NewReader(body)))
		return w
	}
	if w := invoke(qt.NewQueryV3Handler(db, nil), "POST", string(body)); w.Code != 403 {
		t.Fatal(w)
	}
	denied := qt.NewQueryV3Handler(db, func(*http.Request) (qt.QueryDatasetV3, qt.PlanOptions, error) {
		return d, qt.PlanOptions{}, errors.New("denied")
	})
	if w := invoke(denied, "POST", string(body)); w.Code != 403 {
		t.Fatal(w)
	}
	handler := qt.NewQueryV3Handler(db, func(*http.Request) (qt.QueryDatasetV3, qt.PlanOptions, error) { return d, qt.PlanOptions{}, nil })
	if w := invoke(handler, "GET", string(body)); w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal(w)
	}
	if w := invoke(handler, "POST", string(body)); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body.String())
	}
	var object map[string]any
	if err = json.Unmarshal(body, &object); err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range []func(map[string]any){
		func(v map[string]any) { delete(v, "now") },
		func(v map[string]any) { v["now"] = nil },
		func(v map[string]any) { v["sql"] = "SELECT * FROM secret" },
		func(v map[string]any) { v["source"].(map[string]any)["sql"] = "SELECT * FROM secret" },
	} {
		var copy map[string]any
		json.Unmarshal(body, &copy)
		corrupt(copy)
		bad, _ := json.Marshal(copy)
		if w := invoke(handler, "POST", string(bad)); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := invoke(handler, "POST", string(body)+" {}"); w.Code != 400 {
		t.Fatal(w)
	}
	if w := invoke(handler, "POST", strings.Repeat(" ", 2<<20)+string(body)); w.Code != 400 {
		t.Fatal(w)
	}
}

func TestV3HTTPExecutionErrors(t *testing.T) {
	db, d := setupV3(t)
	for _, test := range []struct {
		name   string
		modify func(*qt.QueryRequestV3, *qt.QueryDatasetV3, *qt.PlanOptions)
		status int
		body   string
	}{
		{"database", func(_ *qt.QueryRequestV3, d *qt.QueryDatasetV3, _ *qt.PlanOptions) {
			d.SourceSQL = "SELECT * FROM private_host_catalog"
		}, 500, "could not execute query\n"},
		{"host failure", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, o *qt.PlanOptions) {
			q.PlanToken = "plan"
			o.ValidatePlanToken = func(context.Context, string) error {
				return errors.New("private_host_catalog /private/database/path generated SQL qt_v3_secret")
			}
		}, 500, "could not execute query\n"},
		{"deadline", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, o *qt.PlanOptions) {
			q.PlanToken = "plan"
			o.ValidatePlanToken = func(context.Context, string) error {
				return fmt.Errorf("private_host_catalog: %w", context.DeadlineExceeded)
			}
		}, 504, "query timed out\n"},
		{"wrapped diagnostic", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, o *qt.PlanOptions) {
			q.PlanToken = "plan"
			o.ValidatePlanToken = func(context.Context, string) error {
				return fmt.Errorf("private_host_catalog: %w", &qt.PlanDiagnostic{Code: "plan_expired", Message: "refresh the plan"})
			}
		}, 400, "plan_expired: refresh the plan\n"},
		{"invalid source limit", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, _ *qt.PlanOptions) { q.Source.Limit = -1 }, 400, ""},
		{"malformed source filter", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, _ *qt.PlanOptions) {
			q.Source.Where = []qt.WhereTerm{{Op: "=", Value: "x"}}
		}, 400, ""},
		{"unsupported filter operator", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, _ *qt.PlanOptions) {
			q.Source.Where = []qt.WhereTerm{{Field: "k", Op: "unknown", Value: "x"}}
		}, 400, ""},
		{"invalid metric id", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, _ *qt.PlanOptions) {
			q.Metrics = []qt.AggSpec{{Op: "count"}}
		}, 400, ""},
		{"too many metric groups", func(q *qt.QueryRequestV3, _ *qt.QueryDatasetV3, _ *qt.PlanOptions) {
			q.Metrics = []qt.AggSpec{{ID: "count", Op: "count", GroupBy: make([]string, qt.MaxGroupByFields+1)}}
		}, 400, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, dataset, options := groupedRequest(), d, qt.PlanOptions{}
			test.modify(&query, &dataset, &options)
			body, err := json.Marshal(query)
			if err != nil {
				t.Fatal(err)
			}
			handler := qt.NewQueryV3Handler(db, func(*http.Request) (qt.QueryDatasetV3, qt.PlanOptions, error) { return dataset, options, nil })
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest("POST", "/query", strings.NewReader(string(body))))
			if w.Code != test.status || test.body != "" && w.Body.String() != test.body {
				t.Fatal(w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "private_host_catalog") || strings.Contains(w.Body.String(), "qt_v3_secret") {
				t.Fatal("internal details leaked", w.Body.String())
			}
		})
	}
}

func TestV3GroupIdentityUsesBrowserFieldNameOrdering(t *testing.T) {
	db, d := setupV3(t)
	for _, name := range []string{"\ue000", "😀"} {
		field := d.Schema.Fields["k"]
		field.Name = name
		d.Schema.Fields[name] = field
	}
	q := groupedRequest()
	q.Source.Where = []qt.WhereTerm{{Field: "k", Op: "=", Value: "a"}}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"\ue000", "😀"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}}}
	q.Result = qt.WireQuery{Select: []string{"num"}, Limit: 10}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || len(out.Rows) != 1 || out.Rows[0][qt.GroupIdentityField] != "[[\"😀\",\"a\"],[\"\ue000\",\"a\"]]" {
		t.Fatal(out, err)
	}
}

func TestV3NarrowSourceKeepsHiddenSortAndEnumProjection(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 2, OrderBy: qt.OrderBys{{Field: "n", Dir: "desc"}}}
	plan, err := d.SourcePlan(context.Background(), q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(plan.Fields, []string{"id", "n"}) {
		t.Fatal(plan.Fields, err)
	}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" {
		t.Fatal(out, err)
	}
	d.Schema.DefaultSort = q.Result.OrderBy
	q.Result.OrderBy = nil
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" {
		t.Fatal(out, err)
	}
	label := d.Schema.Fields["label"]
	label.SQLiteSortField, label.SortExpr = "n", "r.n"
	d.Schema.Fields["label"] = label
	q.Result.OrderBy = qt.OrderBys{{Field: "label", Dir: "desc"}}
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" {
		t.Fatal(out, err)
	}
	k := d.Schema.Fields["k"]
	k.Kind = qt.FieldEnum
	d.Schema.Fields["k"] = k
	q = groupedRequest()
	q.Grouping.Summaries = []qt.SummaryColumn{{ID: "chosen", Op: "row", Field: "k"}, {ID: "smallest", Op: "min", Field: "k"}}
	q.Result = qt.WireQuery{Select: []string{"k", "chosen", "smallest"}, Limit: 10}
	plan, err = d.SourcePlan(context.Background(), q, qt.PlanOptions{})
	if err != nil || plan.ResultSchema.Fields["chosen"].Kind != qt.FieldEnum || plan.ResultSchema.Fields["smallest"].Kind != qt.FieldEnum {
		t.Fatal(plan, err)
	}
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range out.Schema.Fields {
		if field.Name != qt.GroupIdentityField && field.Type != "enum" {
			t.Fatal(out.Schema)
		}
	}
}

func TestV3ComputedPoliciesSamplesAndSnapshotValidation(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	d.MaxSamplesPerGroup = 2
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
		t.Fatal("summary sample budget ignored")
	}
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "median", Expression: "MEDIAN([n])"}}
	if out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil || out.Metrics[0].Error != "MEDIAN exceeded the 2-sample budget" {
		t.Fatal("metric sample budget ignored", err)
	}
	d.MaxSamplesPerGroup = 0
	field := d.Schema.Fields["n"]
	field.AggregateOps = []string{"sum"}
	d.Schema.Fields["n"] = field
	resolver := qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Double", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}, nil
	})
	q.ExpectedRevisions = map[string]string{"double": "1"}
	q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "@computed/double"}}
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	q.Metrics[0].Op = "avg"
	if out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{Resolver: resolver}); err != nil || out.Metrics[0].Error == "" {
		t.Fatal("materializing computed values bypassed base aggregate policy", err)
	}
	field.AggregateOps = nil
	d.Schema.Fields["n"] = field
	q = groupedRequest()
	q.PlanToken, q.Snapshot = "authorized-plan", "retained-data"
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	tokens, snapshots := 0, 0
	o := qt.PlanOptions{ValidatePlanToken: func(context.Context, string) error { tokens++; return nil }, ValidateSnapshot: func(context.Context, string) error { snapshots++; return nil }}
	if _, err = d.ExecuteIn(context.Background(), tx, q, o); err != nil {
		t.Fatal(err)
	}
	if tokens != 1 || snapshots != 1 {
		t.Fatal("envelope validated more than once", tokens, snapshots)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = d.DescribeComputedPartialIn(ctx, tx, nil, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err = (qt.SQLiteV2Dataset{Schema: d.Schema, SourceSQL: d.SourceSQL}).DescribeComputedPartialIn(ctx, tx, nil, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
