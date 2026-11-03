// Package querytable executes the version 3 query protocol of
// @pythia-software/query-table-core against SQLite or PostgreSQL, validated
// against a server-defined field schema. QueryDatasetV3 runs a QueryRequestV3
// (decoded by DecodeQueryRequestV3; served by NewQueryV3Handler) inside a
// host-authorized source SELECT. The wire types mirror the TS shapes exactly.
//
// Safety model: the column
// expression for each field comes from the schema, never from request input. An
// unknown field is a compile error before any SQL is built. Values reach SQL
// only as bound placeholders ($N). The validated operator and the schema-defined
// expression are the only request-influenced tokens in the SQL text.
//
// Query links: EncodeQueryLink and DecodeQueryLink write and read the whole
// QueryState in the "2j."/"2d." URL tokens of encodeQuery and
// decodeQueryStrict, as a LinkQuery, so a host can build a link to a filtered
// view or validate a link it receives. They reproduce normalizeQueryState and
// the TypeScript limits and error codes (QueryLinkError); the shared fixtures
// in schema/fixtures/query-links.json hold both implementations to the same
// tokens.
package querytable

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Structural limits mirror @pythia-software/query-table-core. Every query stage
// and metric enforces them whether it was decoded from JSON or built by a host.
const (
	// MaxQueryLimit is the largest row limit representable by this platform.
	// The package does not impose a smaller application-level row cap; consumers
	// and their databases own any operational limit appropriate for the dataset.
	MaxQueryLimit       = int(^uint(0) >> 1)
	MaxQueryOffset      = 1_000_000
	MaxSelectColumns    = 200
	MaxWhereClauses     = 100
	MaxOrderByTerms     = 20
	MaxAggregations     = 20
	MaxGroupByFields    = 20
	MaxMetricMinCount   = 1_000_000
	maxFieldNameLength  = 256
	maxFilterValueBytes = 10_000
	maxRegexBytes       = 10_000
	maxQueryTokenBytes  = 2 * 1024 * 1024
)

// WhereClause mirrors @pythia-software/query-table-core WhereClause. Negated wraps
// the predicate in a null-exclusive NOT; it is set only for ops without a
// complementary operator (contains/starts_with/ends_with/includes), matching the
// frontend's negateClause.
//
// As a member of WhereTerm.Any, a clause with All set is instead a conjunction
// branch, {"all": [...]} on the wire (TS WhereConjunction): it matches when
// every literal in All matches. Such a branch has no Field, Op, Value or
// Negated, holds at least one literal, and its literals cannot nest further.
// All is invalid anywhere else.
type WhereClause struct {
	Field   string        `json:"field"`
	Op      string        `json:"op"`
	Value   string        `json:"value"`
	Negated bool          `json:"negated,omitempty"`
	All     []WhereClause `json:"all,omitempty"`
}

// IsConjunction reports whether the clause is an {"all": [...]} branch.
func (c WhereClause) IsConjunction() bool { return c.All != nil }

// MarshalJSON writes a conjunction branch as {"all": [...]} alone and any
// other clause as its field/op/value(/negated) literal.
func (c WhereClause) MarshalJSON() ([]byte, error) {
	if c.IsConjunction() {
		return json.Marshal(struct {
			All []WhereClause `json:"all"`
		}{c.All})
	}
	type literal WhereClause
	return json.Marshal(literal(c))
}

// WhereTerm is one conjunct of the WHERE (mirrors the TS WhereTerm =
// WhereClause | OrGroup | OrOfAndsGroup). It is either a single predicate
// (Field/Op/Value set, Any nil) or a group (Any set) whose members are literals
// or {"all": [...]} conjunction branches: an OR of ANDs such as
// (provider = a AND model = b) OR (provider = c AND model = d). The shapes are
// disjoint on the wire (a literal carries "field", a group "any", a branch
// "all"), so the default JSON (un)marshaling distinguishes them. WHERE is the
// AND of these terms. Every literal, including those inside branches, counts
// against MaxWhereClauses, which therefore also bounds the branch count.
type WhereTerm struct {
	Field   string        `json:"field,omitempty"`
	Op      string        `json:"op,omitempty"`
	Value   string        `json:"value,omitempty"`
	Negated bool          `json:"negated,omitempty"`
	Any     []WhereClause `json:"any,omitempty"`
	// SetFilter marks the term as set-editor output (presentation only; the
	// compilers ignore it). Query links pack intact array set filters.
	SetFilter *SetFilterMetadata `json:"setFilter,omitempty"`
}

// IsGroup reports whether the term is a group (an OR of literals or of
// conjunction branches) rather than a single predicate.
func (t WhereTerm) IsGroup() bool { return t.Any != nil }

// Literal returns the predicate a non-group term represents.
func (t WhereTerm) Literal() WhereClause {
	return WhereClause{Field: t.Field, Op: t.Op, Value: t.Value, Negated: t.Negated}
}

// Predicates returns every literal the term references: itself for a single
// predicate, a group's members, and the literals of each conjunction branch.
// Use it to visit fields and count predicates; use Branches for meaning.
func (t WhereTerm) Predicates() []WhereClause {
	if !t.IsGroup() {
		return []WhereClause{t.Literal()}
	}
	out := make([]WhereClause, 0, len(t.Any))
	for _, member := range t.Any {
		if member.IsConjunction() {
			out = append(out, member.All...)
		} else {
			out = append(out, member)
		}
	}
	return out
}

// Branches returns the term as an OR of ANDs: it matches when every literal of
// some branch matches. A single predicate is one one-literal branch, and each
// literal member of a group is its own branch.
func (t WhereTerm) Branches() [][]WhereClause {
	if !t.IsGroup() {
		return [][]WhereClause{{t.Literal()}}
	}
	out := make([][]WhereClause, 0, len(t.Any))
	for _, member := range t.Any {
		if member.IsConjunction() {
			out = append(out, member.All)
		} else {
			out = append(out, []WhereClause{member})
		}
	}
	return out
}

// validateWhereShape rejects empty or nested conjunction branches and branches
// that also carry literal fields.
func validateWhereShape(t WhereTerm) error {
	for _, member := range t.Any {
		if !member.IsConjunction() {
			continue
		}
		if member.Field != "" || member.Op != "" || member.Value != "" || member.Negated {
			return fmt.Errorf("invalid filter branch: a branch is either a literal or {\"all\": [...]}")
		}
		if len(member.All) == 0 {
			return fmt.Errorf("filter group has an empty AND branch")
		}
		for _, literal := range member.All {
			if literal.IsConjunction() {
				return fmt.Errorf("filter AND branches cannot nest")
			}
		}
	}
	return nil
}

// OrderBy mirrors @pythia-software/query-table-core OrderByClause.
type OrderBy struct {
	Field   string        `json:"field"`
	Dir     string        `json:"dir"`             // "asc" | "desc"
	Nulls   string        `json:"nulls,omitempty"` // "first" | "last" | "" (default last)
	Extract *RegexExtract `json:"extract,omitempty"`
}

// RegexExtract transforms a sort value before comparison. PostgreSQL's
// substring(text FROM regex) returns the first capture group when present and
// the whole match otherwise; a non-match is NULL.
type RegexExtract struct {
	Regex string `json:"regex"`
}

// AggSpec mirrors @pythia-software/query-table-core AggregationClause: one aggregate op over one
// measure column (Field; empty ⇒ COUNT(*)), broken down by zero or more group
// columns. A QueryRequestV3 runs one per metric over the matching population
// (or the shown page, for Scope "shownRows").
type AggSpec struct {
	DateGrouping *MetricDateGrouping `json:"dateGrouping,omitempty"`
	Diagnostics  []string            `json:"diagnostics,omitempty"`
	Display      *MetricDisplayHint  `json:"display,omitempty"`
	Expression   string              `json:"expression,omitempty"`
	ExpressionY  string              `json:"expressionY,omitempty"`
	Scope        string              `json:"scope,omitempty"`
	Sort         []MetricSort        `json:"sort,omitempty"`
	GroupLimit   int                 `json:"groupLimit,omitempty"`
	Distribution *MetricDistribution `json:"distribution,omitempty"`
	ID           string              `json:"id"`
	Op           string              `json:"op"`
	Field        string              `json:"field,omitempty"`
	GroupBy      []string            `json:"groupBy,omitempty"`
	// Where is this metric's own predicate, ANDed with the table WHERE before
	// grouping (inside the page for shownRows). It never changes table rows.
	Where []WhereTerm `json:"where,omitempty"`
	// MinCount drops groups with fewer rows (after Where), or fewer distinct
	// values or a smaller sum of a field, before ordering, GroupLimit and Other;
	// removed groups are reported as hidden_groups.
	MinCount MetricMinCount `json:"minCount,omitzero"`
}

// WireQuery is one stage (source or result) of a QueryRequestV3: the TS
// ServerQuery. On the wire it has exactly select, where, orderBy, limit and
// offset; view-only state (column widths) never arrives.
type WireQuery struct {
	Select  []string    `json:"select,omitempty"`
	Where   []WhereTerm `json:"where,omitempty"`
	OrderBy []OrderBy   `json:"orderBy,omitempty"`
	Limit   int         `json:"limit,omitempty"`
	Offset  int         `json:"offset,omitempty"`
}

// UnmarshalJSON rejects unknown stage properties and validates resource
// limits before returning, so a normal json.Decoder is a safe API boundary
// even when the caller does not use DecodeQueryRequestV3.
func (q *WireQuery) UnmarshalJSON(data []byte) error {
	type stage WireQuery
	var payload stage
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return err
	}
	*q = WireQuery(payload)
	return q.Validate()
}

// Validate rejects malformed query shapes. A zero Limit is allowed so an
// omitted value can be replaced by the caller's default; a negative value is
// never allowed. Values too large for the platform fail during JSON decoding.
func (q WireQuery) Validate() error {
	if q.Limit < 0 || q.Limit > MaxQueryLimit {
		return fmt.Errorf("limit must be between 0 and %d", MaxQueryLimit)
	}
	if q.Offset < 0 || q.Offset > MaxQueryOffset {
		return fmt.Errorf("offset must be between 0 and %d", MaxQueryOffset)
	}
	if len(q.Select) > MaxSelectColumns {
		return fmt.Errorf("select has %d fields; maximum is %d", len(q.Select), MaxSelectColumns)
	}
	if len(q.Where) > MaxWhereClauses {
		return fmt.Errorf("where has %d terms; maximum is %d", len(q.Where), MaxWhereClauses)
	}
	if len(q.OrderBy) > MaxOrderByTerms {
		return fmt.Errorf("orderBy has %d terms; maximum is %d", len(q.OrderBy), MaxOrderByTerms)
	}
	for _, field := range q.Select {
		if field == "" || len(field) > maxFieldNameLength {
			return fmt.Errorf("invalid select field name")
		}
	}
	whereLiterals := 0
	for _, term := range q.Where {
		if err := validateWhereShape(term); err != nil {
			return err
		}
		for _, clause := range term.Predicates() {
			if clause.Field == "" || len(clause.Field) > maxFieldNameLength {
				return fmt.Errorf("invalid filter field name")
			}
			if len(clause.Value) > maxFilterValueBytes {
				return fmt.Errorf("filter value for %q exceeds %d bytes", clause.Field, maxFilterValueBytes)
			}
			whereLiterals++
		}
	}
	if whereLiterals > MaxWhereClauses {
		return fmt.Errorf("where has %d clauses; maximum is %d", whereLiterals, MaxWhereClauses)
	}
	for _, term := range q.OrderBy {
		if term.Field == "" || len(term.Field) > maxFieldNameLength {
			return fmt.Errorf("invalid sort field name")
		}
		if term.Extract != nil && len(term.Extract.Regex) > maxRegexBytes {
			return fmt.Errorf("sort regex for %q exceeds %d bytes", term.Field, maxRegexBytes)
		}
	}
	return nil
}

// validateMetricSpecs rejects malformed metric shapes before compilation.
func validateMetricSpecs(specs []AggSpec) error {
	if len(specs) > MaxAggregations {
		return fmt.Errorf("aggregations has %d items; maximum is %d", len(specs), MaxAggregations)
	}
	for _, aggregation := range specs {
		if aggregation.ID == "" || len(aggregation.ID) > maxFieldNameLength {
			return fmt.Errorf("invalid aggregation id")
		}
		if len(aggregation.GroupBy) > MaxGroupByFields {
			return fmt.Errorf("aggregation %q has %d group fields; maximum is %d", aggregation.ID, len(aggregation.GroupBy), MaxGroupByFields)
		}
		if err := aggregation.MinCount.validate(aggregation.ID); err != nil {
			return err
		}
		metricLiterals := 0
		for _, term := range aggregation.Where {
			if term.IsGroup() && len(term.Any) == 0 {
				return fmt.Errorf("aggregation %q has an empty filter group", aggregation.ID)
			}
			if err := validateWhereShape(term); err != nil {
				return fmt.Errorf("aggregation %q: %w", aggregation.ID, err)
			}
			for _, clause := range term.Predicates() {
				if clause.Field == "" || len(clause.Field) > maxFieldNameLength {
					return fmt.Errorf("invalid metric filter field name")
				}
				if len(clause.Value) > maxFilterValueBytes {
					return fmt.Errorf("metric filter value for %q exceeds %d bytes", clause.Field, maxFilterValueBytes)
				}
				metricLiterals++
			}
		}
		if metricLiterals > MaxWhereClauses {
			return fmt.Errorf("aggregation %q filter has %d clauses; maximum is %d", aggregation.ID, metricLiterals, MaxWhereClauses)
		}
	}
	return nil
}
