// Package querytable compiles a frontend QueryState into parameterized SQL,
// validated against a server-defined field schema. It is the Go projection of
// @query-table/core: the wire types here mirror the TS shapes exactly so a
// base64url ?q= token (or a JSON request body) round-trips without translation.
//
// Safety model (carried over from explo's perfstore/querydsl.go): the column
// expression for each field comes from the schema, never from request input. An
// unknown field is a compile error before any SQL is built. Values reach SQL
// only as bound placeholders ($N). The validated operator and the schema-defined
// expression are the only request-influenced tokens in the SQL text.
package querytable

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// WhereClause mirrors @query-table/core WhereClause.
type WhereClause struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

// OrderBy mirrors @query-table/core OrderByClause.
type OrderBy struct {
	Field string `json:"field"`
	Dir   string `json:"dir"`             // "asc" | "desc"
	Nulls string `json:"nulls,omitempty"` // "first" | "last" | "" (default last)
}

// AggSpec mirrors @query-table/core AggregationClause: one aggregate op over one
// measure column (Field; empty ⇒ COUNT(*)), broken down by zero or more group
// columns. Compiled by CompileAggregation; the metric panel runs one per spec
// over the WHERE-filtered set (no paging).
type AggSpec struct {
	ID      string   `json:"id"`
	Op      string   `json:"op"`
	Field   string   `json:"field,omitempty"`
	GroupBy []string `json:"groupBy,omitempty"`
}

// WireQuery is the server-bound subset of QueryState (the TS ServerQuery / the
// {s,w,o,...} `?q=` payload). View-only state (column widths) never arrives.
//
// OrderBy unmarshals from BOTH the new array form and the legacy single-object
// form, so old xplo-perf / xlsx-collect links keep compiling.
type WireQuery struct {
	Select       []string      `json:"select,omitempty"`
	Where        []WhereClause `json:"w,omitempty"`
	OrderBy      OrderBys      `json:"o,omitempty"`
	Limit        int           `json:"l,omitempty"`
	Offset       int           `json:"f,omitempty"`
	Aggregations []AggSpec     `json:"g,omitempty"`
}

// OrderBys is a slice of OrderBy that also accepts a single object on decode
// (legacy compatibility) and a base64url `c`/`s` is handled at the WireQuery
// level via DecodeWireQuery.
type OrderBys []OrderBy

// UnmarshalJSON accepts either `[{...},{...}]` (current) or `{...}` (legacy).
func (o *OrderBys) UnmarshalJSON(b []byte) error {
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "null" || trimmed == "" {
		*o = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var arr []OrderBy
		if err := json.Unmarshal(b, &arr); err != nil {
			return err
		}
		*o = arr
		return nil
	}
	var single OrderBy
	if err := json.Unmarshal(b, &single); err != nil {
		return err
	}
	*o = []OrderBy{single}
	return nil
}

// wirePayload is the compact JSON the frontend base64url-encodes. `c` is the
// legacy alias for select column names; `s` is the current select (tuples).
type wirePayload struct {
	Select json.RawMessage `json:"s,omitempty"` // [field] | [field,width] tuples, or legacy string[]
	Legacy json.RawMessage `json:"c,omitempty"` // legacy string[]
	Where  []WhereClause   `json:"w,omitempty"`
	Order  OrderBys        `json:"o,omitempty"`
	Limit  int             `json:"l,omitempty"`
	Offset int             `json:"f,omitempty"`
	Aggs   []AggSpec       `json:"g,omitempty"`
}

// DecodeWireQuery decodes the base64url-encoded JSON `?q=` token produced by
// @query-table/core encodeQuery. The select tuples carry widths the server
// ignores; only the field names are extracted. Mirrors the charset/padding
// fix-ups so a bookmark round-trips bit-for-bit.
func DecodeWireQuery(token string) (WireQuery, error) {
	var q WireQuery
	if token == "" {
		return q, nil
	}
	s := strings.ReplaceAll(token, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	if pad := len(s) % 4; pad != 0 {
		s += strings.Repeat("=", 4-pad)
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return q, fmt.Errorf("base64: %w", err)
	}
	var p wirePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return q, fmt.Errorf("json: %w", err)
	}
	q.Where = p.Where
	q.OrderBy = p.Order
	q.Limit = p.Limit
	q.Offset = p.Offset
	q.Aggregations = p.Aggs
	q.Select = decodeSelect(p.Select, p.Legacy)
	return q, nil
}

// decodeSelect pulls field names from the `s` tuples (or legacy `c`/`s` string[]).
func decodeSelect(s, legacy json.RawMessage) []string {
	for _, raw := range []json.RawMessage{s, legacy} {
		if len(raw) == 0 {
			continue
		}
		// Try string[] first (legacy), then tuple form.
		var names []string
		if err := json.Unmarshal(raw, &names); err == nil {
			return names
		}
		var tuples [][]json.RawMessage
		if err := json.Unmarshal(raw, &tuples); err == nil {
			out := make([]string, 0, len(tuples))
			for _, t := range tuples {
				if len(t) == 0 {
					continue
				}
				var name string
				if err := json.Unmarshal(t[0], &name); err == nil {
					out = append(out, name)
				}
			}
			return out
		}
	}
	return nil
}
