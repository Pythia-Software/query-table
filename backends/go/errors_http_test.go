package querytable

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type unreachableConnector struct{}

func (unreachableConnector) Connect(context.Context) (driver.Conn, error) {
	return nil, errors.New("database password=secret unreachable")
}
func (unreachableConnector) Driver() driver.Driver { return nil }

// decodeErrorBody asserts the QueryErrorBody shape every handler writes.
func decodeErrorBody(t *testing.T, name string, w *httptest.ResponseRecorder, status int, code ErrorCode) QueryErrorDetail {
	t.Helper()
	if w.Code != status {
		t.Fatalf("%s: status %d, want %d (%s)", name, w.Code, status, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("%s: content type %q", name, got)
	}
	var raw map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil || len(raw) != 1 || raw["error"] == nil {
		t.Fatalf("%s: body %q is not a QueryErrorBody: %v", name, w.Body.String(), err)
	}
	for key := range raw["error"] {
		if !containsString([]string{"code", "message", "field", "offset", "metricId"}, key) {
			t.Fatalf("%s: unexpected error key %q", name, key)
		}
	}
	var body QueryErrorBody
	decoder := json.NewDecoder(strings.NewReader(w.Body.String()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		t.Fatal(name, err)
	}
	if body.Error.Code != code || body.Error.Message == "" || body.Error.Code.HTTPStatus() != status {
		t.Fatalf("%s: error %+v, want code %s", name, body.Error, code)
	}
	return body.Error
}

func TestQueryV3HandlerErrorBodies(t *testing.T) {
	db := sql.OpenDB(unreachableConnector{})
	defer db.Close()
	dataset := QueryDatasetV3{Schema: Schema{Name: "runs", IDField: "id", Fields: map[string]FieldSpec{"id": {Name: "id", Kind: FieldText, Expr: "id", ServerFilter: true, Sortable: true}}}, SourceSQL: "runs"}
	allow := func(*http.Request) (QueryDatasetV3, PlanOptions, error) { return dataset, PlanOptions{}, nil }
	valid := `{"version":3,"profile":"` + dataset.Capabilities().Profile + `","now":0,"expectedRevisions":{},"source":{"select":[],"where":[],"orderBy":[],"limit":1,"offset":0},"result":{"select":["id"],"where":[],"orderBy":[],"limit":1,"offset":0},"rows":true,"metrics":[]}`
	for _, tc := range []struct {
		name, method, body string
		authorize          func(*http.Request) (QueryDatasetV3, PlanOptions, error)
		status             int
		code               ErrorCode
	}{
		{"method", "GET", "", allow, 405, ErrorCodeMethodNotAllowed},
		{"no authorization", "POST", valid, nil, 403, ErrorCodeForbidden},
		{"denied", "POST", valid, func(*http.Request) (QueryDatasetV3, PlanOptions, error) {
			return QueryDatasetV3{}, PlanOptions{}, errors.New("no")
		}, 403, ErrorCodeForbidden},
		{"too large", "POST", strings.Repeat(" ", 2<<20+1), allow, 413, ErrorCodeRequestTooLarge},
		{"not json", "POST", `{"version":`, allow, 400, ErrorCodeInvalidJSON},
		{"two values", "POST", valid + valid, allow, 400, ErrorCodeInvalidJSON},
		{"unknown key", "POST", strings.Replace(valid, `"metrics":[]`, `"metrics":[],"diagnostics":["residual"]`, 1), allow, 400, ErrorCodeInvalidQuery},
		{"wrong type", "POST", strings.Replace(valid, `"rows":true`, `"rows":"yes"`, 1), allow, 400, ErrorCodeInvalidQuery},
		{"stage limit", "POST", strings.Replace(valid, `"limit":1,"offset":0},"rows"`, `"limit":-1,"offset":0},"rows"`, 1), allow, 400, ErrorCodeInvalidQuery},
		{"version", "POST", strings.Replace(valid, `"version":3`, `"version":2`, 1), allow, 400, ErrorCodeVersion},
		{"metric", "POST", strings.Replace(valid, `"metrics":[]`, `"metrics":[{"id":"n","op":"count","groupBy":[],"minCount":0.5}]`, 1), allow, 400, ErrorCodeInvalidMetric},
		{"snapshot", "POST", strings.Replace(valid, `"now":0`, `"now":0,"snapshot":"s"`, 1), allow, 500, ErrorCodeSnapshotTransactionRequired},
		{"internal", "POST", valid, allow, 500, ErrorCodeInternal},
	} {
		w := httptest.NewRecorder()
		NewQueryV3Handler(db, tc.authorize).ServeHTTP(w, httptest.NewRequest(tc.method, "/query", strings.NewReader(tc.body)))
		detail := decodeErrorBody(t, tc.name, w, tc.status, tc.code)
		if tc.code == ErrorCodeInternal && strings.Contains(detail.Message, "secret") {
			t.Fatalf("internal error leaked its cause: %q", detail.Message)
		}
		if tc.name == "method" && w.Header().Get("Allow") != "POST" {
			t.Fatal("missing Allow header")
		}
	}
}

func TestComputedColumnsHandlerErrorBodies(t *testing.T) {
	allow := func(*http.Request, string, bool) (string, error) { return "one", nil }
	column := `{"column":{"id":"margin","label":"Margin","expression":{"language":"qt-expr","version":1,"source":"[a]"},"revision":""},"expectedRevision":null}`
	for _, tc := range []struct {
		name, method, url, body string
		repo                    *fakeComputedRepo
		authorize               func(*http.Request, string, bool) (string, error)
		status                  int
		code                    ErrorCode
		field                   string
	}{
		{"method", "POST", "/?dataset=runs", "", &fakeComputedRepo{}, allow, 405, ErrorCodeMethodNotAllowed, ""},
		{"dataset", "GET", "/", "", &fakeComputedRepo{}, allow, 400, ErrorCodeInvalidRequest, ""},
		{"forbidden", "GET", "/?dataset=runs", "", &fakeComputedRepo{}, nil, 403, ErrorCodeForbidden, ""},
		{"list", "GET", "/?dataset=runs", "", &fakeComputedRepo{listError: errors.New("db")}, allow, 500, ErrorCodeInternal, ""},
		{"json", "PUT", "/?dataset=runs", `{`, &fakeComputedRepo{}, allow, 400, ErrorCodeInvalidJSON, ""},
		{"shape", "PUT", "/?dataset=runs", `{"other":1}`, &fakeComputedRepo{}, allow, 400, ErrorCodeInvalidRequest, ""},
		{"two values", "PUT", "/?dataset=runs", column + column, &fakeComputedRepo{}, allow, 400, ErrorCodeInvalidJSON, ""},
		{"too large", "PUT", "/?dataset=runs", `{"column":"` + strings.Repeat("x", 128*1024) + `"}`, &fakeComputedRepo{}, allow, 413, ErrorCodeRequestTooLarge, ""},
		{"invalid", "PUT", "/?dataset=runs", strings.Replace(column, `"label":"Margin"`, `"label":" "`, 1), &fakeComputedRepo{}, allow, 400, ErrorCodeDefinitionInvalid, "@computed/margin"},
		{"compile", "PUT", "/?dataset=runs", column, &fakeComputedRepo{saveError: fmt.Errorf("x: %w", &PlanDiagnostic{Code: ErrorCodeSyntax, Message: "expected )", Field: "@computed/margin", Offset: 3})}, allow, 400, ErrorCodeSyntax, "@computed/margin"},
		{"budget", "PUT", "/?dataset=runs", column, &fakeComputedRepo{saveError: &PlanDiagnostic{Code: ErrorCodeDependencyLimit, Message: "too deep"}}, allow, 422, ErrorCodeDependencyLimit, ""},
		{"conflict", "PUT", "/?dataset=runs", column, &fakeComputedRepo{saveError: ErrComputedConflict}, allow, 409, ErrorCodeConflict, ""},
	} {
		w := httptest.NewRecorder()
		NewComputedColumnsHandler(tc.repo, tc.authorize).ServeHTTP(w, httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body)))
		detail := decodeErrorBody(t, tc.name, w, tc.status, tc.code)
		if detail.Field != tc.field || (tc.name == "compile" && detail.Offset != 3) {
			t.Fatalf("%s: %+v", tc.name, detail)
		}
	}
}

func TestQuerySnapshotsHandlerErrorBodies(t *testing.T) {
	code := "aaaaaaaaaaaaaaaaaaaaaa"
	body, _ := json.Marshal(QuerySnapshot{Version: 1, Code: code, Token: "2j.e30", CreatedAt: 1})
	allow := func(*http.Request, string, bool) (string, error) { return "one", nil }
	for _, tc := range []struct {
		name, method, url, body string
		repo                    QuerySnapshotRepository
		authorize               func(*http.Request, string, bool) (string, error)
		status                  int
		code                    ErrorCode
	}{
		{"method", "POST", "/?dataset=runs&code=" + code, "", snapshotTestRepo{rows: map[string]QuerySnapshot{}}, allow, 405, ErrorCodeMethodNotAllowed},
		{"code", "GET", "/?dataset=runs&code=x", "", snapshotTestRepo{rows: map[string]QuerySnapshot{}}, allow, 400, ErrorCodeInvalidRequest},
		{"forbidden", "GET", "/?dataset=runs&code=" + code, "", snapshotTestRepo{rows: map[string]QuerySnapshot{}}, nil, 403, ErrorCodeForbidden},
		{"missing", "GET", "/?dataset=runs&code=" + code, "", snapshotTestRepo{rows: map[string]QuerySnapshot{}}, allow, 404, ErrorCodeNotFound},
		{"invalid", "PUT", "/?dataset=runs&code=" + code, string(body) + "{}", snapshotTestRepo{rows: map[string]QuerySnapshot{}}, allow, 400, ErrorCodeInvalidRequest},
		{"quota", "PUT", "/?dataset=runs&code=" + code, string(body), quotaSnapshotRepo{}, allow, 507, ErrorCodeQuotaExceeded},
	} {
		w := httptest.NewRecorder()
		NewQuerySnapshotsHandler(tc.repo, tc.authorize).ServeHTTP(w, httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body)))
		decodeErrorBody(t, tc.name, w, tc.status, tc.code)
	}
}

func TestErrorCodesAreDistinctAndMapped(t *testing.T) {
	seen := map[ErrorCode]bool{}
	for _, code := range ErrorCodes() {
		if seen[code] || code == "" {
			t.Fatalf("duplicate or empty code %q", code)
		}
		seen[code] = true
		if status := code.HTTPStatus(); status < 400 || status > 599 {
			t.Fatalf("%s: status %d", code, status)
		}
	}
	if ErrorCodeResourceLimit.HTTPStatus() != 422 || ErrorCodeDefinitionChanged.HTTPStatus() != 409 || ErrorCodeSyntax.HTTPStatus() != 400 {
		t.Fatal("unexpected status mapping")
	}
	var link QueryLinkErrorCode = QueryLinkTooLarge
	if !seen[link] {
		t.Fatal("query link codes must be ErrorCodes")
	}
}
