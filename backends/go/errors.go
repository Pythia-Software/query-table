package querytable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// The ErrorCode type, its constants and ErrorCode.HTTPStatus are generated
// from schema/query-wire.schema.json (wire_generated.go); docs/errors.md
// lists every code with its status.

func fieldDiagnostic(code ErrorCode, field, message string) error {
	return &PlanDiagnostic{Code: code, Message: message, Field: field}
}

func diagnosticf(code ErrorCode, format string, args ...any) error {
	return &PlanDiagnostic{Code: code, Message: fmt.Sprintf(format, args...)}
}

// withMetric attributes a coded error to one metric. The message names the
// metric unless it already does.
func withMetric(err error, id string) error {
	var issue *PlanDiagnostic
	if !errors.As(err, &issue) {
		return &PlanDiagnostic{Code: ErrorCodeInvalidMetric, Message: fmt.Sprintf("aggregation %q: %v", id, err), MetricID: id}
	}
	out := *issue
	out.MetricID = id
	if !strings.Contains(out.Message, fmt.Sprintf("%q", id)) {
		out.Message = fmt.Sprintf("aggregation %q: %s", id, out.Message)
	}
	return &out
}

// withContext prefixes a coded error's message (such as "source: "), keeping
// its code; an uncoded error becomes code.
func withContext(err error, code ErrorCode, prefix string) error {
	var issue *PlanDiagnostic
	if !errors.As(err, &issue) {
		return &PlanDiagnostic{Code: code, Message: prefix + err.Error()}
	}
	out := *issue
	out.Message = prefix + out.Message
	return &out
}

// ErrorDetail classifies an error from DecodeQueryRequestV3, Execute or a
// repository as the machine-readable QueryErrorDetail the HTTP handlers
// write. Errors without a code are internal; their text is not exposed.
func ErrorDetail(err error) QueryErrorDetail {
	var issue *PlanDiagnostic
	var link *QueryLinkError
	var tooLarge *http.MaxBytesError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return QueryErrorDetail{Code: ErrorCodeTimeout, Message: "query timed out"}
	case errors.Is(err, context.Canceled):
		return QueryErrorDetail{Code: ErrorCodeCancelled, Message: "query cancelled"}
	case errors.As(err, &issue):
		return QueryErrorDetail{Code: issue.Code, Message: issue.Message, Field: issue.Field, Offset: issue.Offset, MetricID: issue.MetricID}
	case errors.As(err, &link):
		return QueryErrorDetail{Code: link.Code, Message: link.Message}
	case errors.As(err, &tooLarge):
		return QueryErrorDetail{Code: ErrorCodeRequestTooLarge, Message: fmt.Sprintf("request exceeds %d bytes", tooLarge.Limit)}
	}
	return QueryErrorDetail{Code: ErrorCodeInternal, Message: "could not execute query"}
}

// WriteQueryError writes err as a JSON QueryErrorBody with the status of its
// code (ErrorCode.HTTPStatus). Hosts that wrap the handlers can use it for
// their own failures so clients see one error shape.
func WriteQueryError(w http.ResponseWriter, err error) {
	writeErrorDetail(w, ErrorDetail(err))
}

func writeErrorCode(w http.ResponseWriter, code ErrorCode, message string) {
	writeErrorDetail(w, QueryErrorDetail{Code: code, Message: message})
}

func writeErrorDetail(w http.ResponseWriter, detail QueryErrorDetail) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Del("Content-Length")
	w.WriteHeader(detail.Code.HTTPStatus())
	_ = json.NewEncoder(w).Encode(QueryErrorBody{Error: detail})
}

// decodeError gives a JSON decoding failure a code: invalid_json for bytes
// that are not JSON, request_too_large past a MaxBytesReader, and
// shape (invalid_query, invalid_request) for JSON of the wrong shape (unknown keys, wrong types).
// Coded errors from UnmarshalJSON methods pass through.
func decodeError(err error, shape ErrorCode) error {
	var issue *PlanDiagnostic
	var syntax *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &issue):
		return err
	case errors.As(err, &tooLarge):
		return &PlanDiagnostic{Code: ErrorCodeRequestTooLarge, Message: fmt.Sprintf("request exceeds %d bytes", tooLarge.Limit)}
	case errors.As(err, &syntax), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return &PlanDiagnostic{Code: ErrorCodeInvalidJSON, Message: "request body is not valid JSON"}
	case errors.As(err, &typeErr):
		return &PlanDiagnostic{Code: shape, Message: "wrong JSON type for " + typeErr.Field}
	}
	return &PlanDiagnostic{Code: shape, Message: strings.TrimPrefix(err.Error(), "json: ")}
}
