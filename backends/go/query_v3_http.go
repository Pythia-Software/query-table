package querytable

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func DecodeQueryRequestV3(data []byte) (QueryRequestV3, error) {
	var q QueryRequestV3
	if len(data) > 2<<20 {
		return q, diagnostic(ErrorCodeRequestTooLarge, "query request exceeds byte budget")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&q); err != nil {
		return q, decodeError(err, ErrorCodeInvalidQuery)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return q, diagnostic(ErrorCodeInvalidJSON, "expected one query object")
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return q, diagnostic(ErrorCodeInvalidQuery, "expected a query object")
	}
	if clock, ok := object["now"]; !ok || bytes.Equal(bytes.TrimSpace(clock), []byte("null")) {
		return q, diagnostic(ErrorCodeDatetimeValue, "one evaluation clock is required")
	}
	for _, name := range []string{"source", "result"} {
		var stage map[string]json.RawMessage
		if json.Unmarshal(object[name], &stage) != nil || stage == nil {
			return q, diagnostic(ErrorCodeInvalidQuery, "source and result must be query objects")
		}
		for key := range stage {
			if !containsString([]string{"select", "where", "orderBy", "limit", "offset"}, key) {
				return q, diagnostic(ErrorCodeInvalidQuery, "unsupported query stage property: "+key)
			}
		}
	}
	if err := q.Validate(); err != nil {
		return q, err
	}
	return q, nil
}

// Authorization chooses the complete dataset/options from trusted host state,
// including read access and same-origin/CSRF policy. Nil authorization denies.
// Permanent query snapshots are distinct from retained data snapshot bindings.
func NewQueryV3Handler(db *sql.DB, authorize func(*http.Request) (QueryDatasetV3, PlanOptions, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeErrorCode(w, ErrorCodeMethodNotAllowed, "method not allowed")
			return
		}
		if db == nil || authorize == nil {
			writeErrorCode(w, ErrorCodeForbidden, "forbidden")
			return
		}
		dataset, options, err := authorize(r)
		if err != nil {
			writeErrorCode(w, ErrorCodeForbidden, "forbidden")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeErrorCode(w, ErrorCodeRequestTooLarge, "query request exceeds byte budget")
			} else {
				writeErrorCode(w, ErrorCodeInvalidRequest, "could not read the request body")
			}
			return
		}
		q, err := DecodeQueryRequestV3(body)
		if err != nil {
			WriteQueryError(w, err)
			return
		}
		result, err := dataset.Execute(ctx, db, q, options)
		if err != nil {
			// Timeouts, cancellation and coded diagnostics keep their code;
			// anything else is internal and its text is not exposed.
			WriteQueryError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
}
