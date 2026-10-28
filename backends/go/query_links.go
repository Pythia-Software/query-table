package querytable

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

// Size limits of a query link, matching MAX_QUERY_STATE_BYTES and
// MAX_QUERY_TOKEN_LENGTH in @pythia-software/query-table-core.
const (
	// MaxQueryStateBytes bounds the UTF-8 JSON a link carries, before
	// compression and after inflation.
	MaxQueryStateBytes = 4 * 1024 * 1024
	// MaxQueryTokenLength bounds a token in UTF-16 code units, as JavaScript
	// measures it. Tokens are ASCII, so this is also their length in bytes.
	MaxQueryTokenLength = 2 * 1024 * 1024
)

// QueryLinkErrorCode is the code of the matching TypeScript QueryDecodeError.
type QueryLinkErrorCode string

const (
	QueryLinkInvalid            QueryLinkErrorCode = "invalid"
	QueryLinkTooLarge           QueryLinkErrorCode = "too_large"
	QueryLinkUnsupportedVersion QueryLinkErrorCode = "unsupported_version"
)

// QueryLinkError is returned by EncodeQueryLink and DecodeQueryLink. Code maps
// one to one onto QueryDecodeError.code; Message matches the TypeScript message
// where one exists.
type QueryLinkError struct {
	Code    QueryLinkErrorCode
	Message string
}

func (e *QueryLinkError) Error() string { return e.Message }

func linkError(code QueryLinkErrorCode, message string) error {
	return &QueryLinkError{Code: code, Message: message}
}

// SetFilterMetadata mirrors SetFilterMetadata: the presentation identity of a
// set editor. Execution always uses the predicates it accompanies.
type SetFilterMetadata struct {
	ID     string   `json:"id"`
	Mode   string   `json:"mode"` // "any" | "all" | "none" | "empty"
	Values []string `json:"values"`
}

// LinkColumn is one SELECT column of a LinkQuery.
type LinkColumn struct {
	Field string `json:"field"`
	// Width is the pixel width override; 0 means none. Normalization clamps
	// other values to 24–2000.
	Width int `json:"width,omitempty"`
	// Display is the column's CellDisplay JSON, or nil. A malformed display is
	// dropped, as in normalizeQueryState.
	Display json.RawMessage `json:"display,omitempty"`
}

// LinkQuery is the whole QueryState a query link carries: everything
// encodeQuery writes and decodeQueryStrict reads. Typed members reuse the
// wire types; members whose shape belongs to the TypeScript packages are
// normalized JSON, so nothing the TypeScript state keeps is lost in Go.
//
// DecodeQueryLink returns the normalized state. EncodeQueryLink normalizes its
// input exactly as normalizeQueryState does, so callers may pass partial
// values (zero Limit for the default page size, unclamped widths).
type LinkQuery struct {
	Select []LinkColumn `json:"select"`
	// Where is conjunctive normal form, as in WireQuery. A term's SetFilter
	// marks set-editor output; array (includes) set filters travel packed.
	Where   []WhereTerm `json:"where"`
	OrderBy []OrderBy   `json:"orderBy"`
	// Limit is the page size; 0 means the default, 100.
	Limit  int64 `json:"limit"`
	Offset int   `json:"offset"`
	// Aggregations holds one AggregationClause JSON object per metric.
	Aggregations []json.RawMessage `json:"aggregations,omitempty"`
	// ItemDetails is the ItemDetailsState JSON, or nil.
	ItemDetails json.RawMessage `json:"itemDetails,omitempty"`
	FitToScreen bool            `json:"fitToScreen,omitempty"`
	// Grouping is the GroupingState JSON, or nil.
	Grouping json.RawMessage `json:"grouping,omitempty"`
}

// EncodeQueryLink is encodeQuery: it normalizes q, packs it into the compact
// v2 wire form and returns a "2j." (base64url JSON) or "2d." (base64url raw
// DEFLATE) token, whichever is shorter. decodeQueryStrict and DecodeQueryLink
// read the token back as the normalized state; the JSON before compression is
// byte-identical to the TypeScript encoder's.
//
// Unlike encodeQuery, it applies decodeQueryStrict's own checks first, so it
// never builds a link whose top-level filters or metrics are dropped or
// widened: a malformed or over-budget predicate, an empty OR group (which
// matches nothing, and which normalization would drop), or an aggregation that
// normalization would discard is a QueryLinkInvalid error. Filters nested in
// metrics, grouping and link patches are normalized as in TypeScript, which
// records a diagnostic or drops the link when it loses a predicate. A state over MaxQueryStateBytes or a token over
// MaxQueryTokenLength is QueryLinkTooLarge.
func EncodeQueryLink(q LinkQuery) (token string, err error) {
	defer recoverJSThrow(&err)
	for _, term := range q.Where {
		if term.IsGroup() && len(term.Any) == 0 {
			return "", linkError(QueryLinkInvalid, "Empty OR group in query predicates.")
		}
	}
	raw, err := q.jsState()
	if err != nil {
		return "", err
	}
	if where := raw.get("where"); where != nil {
		if err := checkStrictPredicates(where); err != nil {
			return "", err
		}
	}
	if aggregations := raw.get("aggregations"); aggregations != nil && len(aggregations.a) > 0 {
		normalized := normalizeLinkQueryState(jsObj().set("aggregations", aggregations)).get("aggregations")
		if normalized == nil || len(normalized.a) != len(aggregations.a) {
			return "", linkError(QueryLinkInvalid, "Invalid query metrics.")
		}
	}
	return encodeLinkState(raw)
}

// DecodeQueryLink is decodeQueryStrict. It reads "2j.", "2d." and legacy
// unprefixed tokens and returns the normalized state; "" is the empty query.
// It rejects other versions (QueryLinkUnsupportedVersion), bad encodings,
// incomplete or corrupt compression, malformed set-filter tuples or property
// view references, malformed or over-budget predicates and metrics
// (QueryLinkInvalid), and tokens or states over the size limits, with
// inflation bounded by MaxQueryStateBytes (QueryLinkTooLarge).
func DecodeQueryLink(token string) (q LinkQuery, err error) {
	defer recoverJSThrow(&err)
	state, err := decodeLinkState(token)
	if err != nil {
		return LinkQuery{}, err
	}
	return linkQueryFromState(state)
}

// recoverJSThrow reports a JavaScript exception raised during normalization
// as decodeToken does: any error that is not a QueryDecodeError is invalid.
func recoverJSThrow(err *error) {
	if r := recover(); r != nil {
		if _, ok := r.(jsThrow); !ok {
			panic(r)
		}
		*err = linkError(QueryLinkInvalid, "Invalid or incomplete query link.")
	}
}

// ---- tokens -----------------------------------------------------------------

func encodeLinkState(state *jsValue) (string, error) {
	text := stringifyJS(packLinkQuery(compactLinkQuery(state)))
	if len(text) > MaxQueryStateBytes {
		return "", linkError(QueryLinkTooLarge, "Query state exceeds the storage limit.")
	}
	plain := "2j." + base64.RawURLEncoding.EncodeToString([]byte(text))
	var compressed bytes.Buffer
	writer, err := flate.NewWriter(&compressed, flate.BestCompression)
	if err != nil {
		return "", err
	}
	if _, err := writer.Write([]byte(text)); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	token := plain
	if deflated := "2d." + base64.RawURLEncoding.EncodeToString(compressed.Bytes()); len(deflated) < len(plain) {
		token = deflated
	}
	if len(token) > MaxQueryTokenLength {
		return "", linkError(QueryLinkTooLarge, "Encoded query state exceeds the storage limit.")
	}
	return token, nil
}

func isBase64URL(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func decodeLinkState(token string) (*jsValue, error) {
	if token == "" {
		return normalizeLinkQueryState(jsObj()), nil
	}
	if len(token) > MaxQueryTokenLength && jsLength(token) > MaxQueryTokenLength {
		return nil, linkError(QueryLinkTooLarge, "Query link exceeds the storage limit.")
	}
	versioned := strings.Contains(token, ".")
	compressed := strings.HasPrefix(token, "2d.")
	if versioned && !compressed && !strings.HasPrefix(token, "2j.") {
		return nil, linkError(QueryLinkUnsupportedVersion, "Unsupported query link version.")
	}
	payload := token
	if versioned {
		payload = token[3:]
	}
	if !isBase64URL(payload) || len(payload)%4 == 1 {
		return nil, linkError(QueryLinkInvalid, "Invalid query link encoding.")
	}
	data, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, linkError(QueryLinkInvalid, "Invalid query link encoding.")
	}
	var text string
	if compressed {
		if text, err = inflateLinkPayload(data); err != nil {
			return nil, err
		}
	} else {
		// Node's Buffer#toString: invalid UTF-8 becomes U+FFFD and a BOM stays.
		text = whatwgUTF8(data)
	}
	if len(text) > MaxQueryStateBytes {
		return nil, linkError(QueryLinkTooLarge, "Query state exceeds the storage limit.")
	}
	raw, err := parseJSValue(text)
	if err != nil {
		return nil, linkError(QueryLinkInvalid, "Invalid or incomplete query link.")
	}
	if !raw.isRecord() {
		return nil, linkError(QueryLinkInvalid, "Invalid query link state.")
	}
	for _, key := range []string{"w", "g"} {
		if value := raw.get(key); value != nil && !value.isArray() {
			return nil, linkError(QueryLinkInvalid, "Invalid query link state.")
		}
	}
	c := raw
	if versioned {
		if err := unpackLinkQuery(c); err != nil {
			return nil, err
		}
	}
	if where := c.get("w"); where != nil {
		if err := checkStrictPredicates(where); err != nil {
			return nil, err
		}
	}
	input := jsObj()
	selection := c.get("s")
	if selection.isNullish() {
		selection = c.get("c")
	}
	input.set("select", compactSelectColumns(selection))
	if where := c.get("w"); where.isArray() {
		input.set("where", where)
	} else {
		input.set("where", jsArr())
	}
	input.set("orderBy", compactOrderBy(c.get("o")))
	for key, name := range map[string]string{"l": "limit", "f": "offset", "g": "aggregations", "d": "itemDetails", "fs": "fitToScreen", "b": "grouping"} {
		if value := c.get(key); value != nil {
			input.set(name, value)
		}
	}
	out := normalizeLinkQueryState(input)
	if metrics := c.get("g"); metrics != nil {
		if kept := out.get("aggregations"); kept == nil || len(kept.a) != len(metrics.a) {
			return nil, linkError(QueryLinkInvalid, "Invalid query metrics.")
		}
	}
	return out, nil
}

// inflateLinkPayload is inflateToken: bounded raw-DEFLATE inflation followed
// by fatal UTF-8 decoding, which drops a leading byte order mark.
func inflateLinkPayload(data []byte) (string, error) {
	stream := flate.NewReader(bytes.NewReader(data))
	defer stream.Close()
	expanded, err := io.ReadAll(io.LimitReader(stream, MaxQueryStateBytes+1))
	if len(expanded) > MaxQueryStateBytes {
		return "", linkError(QueryLinkTooLarge, "Expanded query state exceeds the storage limit.")
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "", linkError(QueryLinkInvalid, "Incomplete compressed query link.")
	}
	if err != nil || !utf8.Valid(expanded) {
		return "", linkError(QueryLinkInvalid, "Invalid or incomplete query link.")
	}
	return strings.TrimPrefix(string(expanded), "\xef\xbb\xbf"), nil
}

// checkStrictPredicates applies decodeQueryStrict's WHERE checks: every term
// is an object, at most MaxWhereClauses predicates, none lost to
// normalization, and `negated` is boolean where present.
func checkStrictPredicates(where *jsValue) error {
	for _, term := range where.a {
		if term == nil || (term.kind != jsObject && term.kind != jsArray) {
			return linkError(QueryLinkInvalid, "Invalid query predicates.")
		}
	}
	count := predicateCount(where.a)
	normalized := normalizeLinkQueryState(jsObj().set("where", where)).get("where")
	invalid := count > MaxWhereClauses || count != predicateCount(normalized.a)
	for _, term := range where.a {
		for _, clause := range predicatesOfJS(term) {
			if clause == nil || (clause.kind != jsObject && clause.kind != jsArray) {
				invalid = true
			} else if negated := clause.get("negated"); negated != nil && negated.kind != jsBool {
				invalid = true
			}
		}
	}
	if invalid {
		return linkError(QueryLinkInvalid, "Invalid query predicates or predicate budget exceeded.")
	}
	return nil
}

// compactSelectColumns is normalizeSelect over `s` tuples or legacy names.
func compactSelectColumns(s *jsValue) *jsValue {
	out := jsArr()
	if !s.isArray() {
		return out
	}
	for _, item := range s.a {
		switch {
		case item.isString():
			out.a = append(out.a, jsObj().set("field", item))
		case item.isArray() && len(item.a) > 0 && item.a[0].isString():
			column := jsObj().set("field", item.a[0])
			if len(item.a) > 1 && item.a[1].isNumber() {
				column.set("width", item.a[1])
			}
			if len(item.a) > 2 {
				column.set("display", item.a[2])
			}
			out.a = append(out.a, column)
		}
	}
	return out
}

// compactOrderBy is normalizeOrderBy: the legacy single object becomes a list.
func compactOrderBy(o *jsValue) *jsValue {
	if !o.truthy() {
		return jsArr()
	}
	if o.isArray() {
		return o
	}
	return jsArr(o)
}

// ---- compact v2 wire form --------------------------------------------------

func compactLinkQuery(state *jsValue) *jsValue {
	q := normalizeLinkQueryState(state)
	c := jsObj()
	if columns := q.get("select"); len(columns.a) > 0 {
		tuples := jsArr()
		for _, column := range columns.a {
			field, width, display := column.get("field"), column.get("width"), column.get("display")
			switch {
			case display.truthy():
				if width.isNullish() {
					width = jsNullValue()
				}
				tuples.a = append(tuples.a, jsArr(field, width, display))
			case !width.isNullish():
				tuples.a = append(tuples.a, jsArr(field, width))
			default:
				tuples.a = append(tuples.a, jsArr(field))
			}
		}
		c.set("s", tuples)
	}
	if where := q.get("where"); len(where.a) > 0 {
		c.set("w", where)
	}
	if orderBy := q.get("orderBy"); len(orderBy.a) > 0 {
		c.set("o", orderBy)
	}
	c.set("l", q.get("limit"))
	if offset := q.get("offset"); offset.truthy() {
		c.set("f", offset)
	}
	if aggregations := q.get("aggregations"); aggregations != nil && len(aggregations.a) > 0 {
		c.set("g", aggregations)
	}
	if details := q.get("itemDetails"); details.truthy() {
		c.set("d", details)
	}
	if q.get("fitToScreen").truthy() {
		c.set("fs", jsBoolValue(true))
	}
	if grouping := q.get("grouping"); grouping.truthy() {
		c.set("b", grouping)
	}
	return c
}

func packLinkQuery(c *jsValue) *jsValue {
	packed := c.spread()
	if limit := c.get("l"); limit.isNumber() && limit.n == linkDefaultLimit {
		packed.del("l")
	}
	if where := c.get("w"); where != nil {
		terms := jsArr()
		for i := 0; i < len(where.a); i++ {
			set, ok := readLinkSetFilter(where.a, i)
			if ok && set.target == "array" {
				terms.a = append(terms.a, jsArr(jsStr("set"), jsStr(set.field), jsStr(set.mode), jsStrings(set.values), jsStr(set.id)))
				i += set.count - 1
			} else {
				terms.a = append(terms.a, where.a[i])
			}
		}
		packed.set("w", terms)
	}
	if details := c.get("d"); details.get("views").truthy() {
		views := details.get("views")
		pool := jsArr()
		refs := jsObj()
		for _, mode := range views.o.keys() {
			view := views.o.values[mode]
			index := -1
			for i, existing := range pool.a {
				if sameJS(existing, view) {
					index = i
					break
				}
			}
			if index < 0 {
				index = len(pool.a)
				pool.a = append(pool.a, view)
			}
			refs.set(mode, jsNum(float64(index)))
		}
		packed.set("d", details.spread().set("views", jsObj().set("pool", pool).set("refs", refs)))
	}
	return packed
}

var linkViewModes = stringSet("hover", "modal", "expand")

func unpackLinkQuery(c *jsValue) error {
	if where := c.get("w"); where.isArray() {
		terms := jsArr()
		for _, term := range where.a {
			if !term.isArray() {
				terms.a = append(terms.a, term)
				continue
			}
			t := term.a
			if len(t) != 5 || !t[0].isString() || t[0].s != "set" || !t[1].isString() || !isStringIn(t[2], linkSetModes) ||
				!t[3].isArray() || len(t[3].a) > MaxWhereClauses || !t[4].isString() {
				return linkError(QueryLinkInvalid, "Invalid set filter in query link.")
			}
			values := make([]string, 0, len(t[3].a))
			for _, value := range t[3].a {
				if !value.isString() || jsLength(value.s) > linkMaxFilterValue {
					return linkError(QueryLinkInvalid, "Invalid set filter in query link.")
				}
				values = append(values, value.s)
			}
			terms.a = append(terms.a, createLinkSetFilter(t[1].s, t[2].s, values, t[4].s, "array")...)
		}
		c.set("w", terms)
	}
	details := c.get("d")
	views := details.get("views")
	if !views.isRecord() {
		return nil
	}
	if _, hasPool := views.o.values["pool"]; !hasPool {
		return nil
	}
	pool, refs := views.get("pool"), views.get("refs")
	if !pool.isArray() || len(pool.a) > 3 || !refs.isRecord() {
		return linkError(QueryLinkInvalid, "Invalid property views in query link.")
	}
	resolved := jsObj()
	for _, mode := range refs.o.keys() {
		index := refs.o.values[mode]
		if !linkViewModes[mode] || !jsIsInteger(index) || index.n < 0 || index.n >= float64(len(pool.a)) {
			return linkError(QueryLinkInvalid, "Invalid property view reference.")
		}
		resolved.set(mode, pool.a[int(index.n)])
	}
	c.set("d", details.spread().set("views", resolved))
	return nil
}

// ---- set filters (setFilter.ts) --------------------------------------------

type linkSetFilter struct {
	field, mode, id, target string
	values                  []string
	count                   int
}

// createLinkSetFilter is createSetFilter for a mode the target supports.
func createLinkSetFilter(field, mode string, values []string, id, target string) []*jsValue {
	keys := jsUniqueStrings(values)
	if mode != "empty" && len(keys) == 0 {
		return nil
	}
	op := "="
	if target == "array" {
		op = "includes"
	}
	clause := func(op, value string) *jsValue {
		return jsObj().set("field", jsStr(field)).set("op", jsStr(op)).set("value", jsStr(value))
	}
	var terms []*jsValue
	switch mode {
	case "empty":
		terms = []*jsValue{clause("is_null", "")}
	case "any":
		if len(keys) == 1 {
			terms = []*jsValue{clause(op, keys[0])}
		} else {
			members := jsArr()
			for _, key := range keys {
				members.a = append(members.a, clause(op, key))
			}
			terms = []*jsValue{jsObj().set("any", members)}
		}
	case "all":
		for _, key := range keys {
			terms = append(terms, clause(op, key))
		}
	default: // none
		for _, key := range keys {
			excluded := clause("!=", key)
			if target == "array" {
				excluded = clause(op, key).set("negated", jsBoolValue(true))
			}
			terms = append(terms, jsObj().set("any", jsArr(clause("is_null", ""), excluded)))
		}
	}
	metadataValues := keys
	if mode == "empty" {
		metadataValues = nil
	}
	for _, term := range terms {
		term.set("setFilter", jsObj().set("id", jsStr(id)).set("mode", jsStr(mode)).set("values", jsStrings(metadataValues)))
	}
	return terms
}

func stripLinkSetFilter(term *jsValue) *jsValue {
	strip := func(clause *jsValue) *jsValue {
		out := clause.spread()
		out.del("setFilter")
		return out
	}
	if any := term.get("any"); any.isArray() {
		members := jsArr()
		for _, member := range any.a {
			members.a = append(members.a, strip(member))
		}
		return jsObj().set("any", members)
	}
	return strip(term)
}

func setFilterID(term *jsValue) *jsValue { return term.get("setFilter").get("id") }

// readLinkSetFilter is readSetFilter: it only collapses intact, explicitly
// marked editor output.
func readLinkSetFilter(where []*jsValue, index int) (linkSetFilter, bool) {
	term := where[index]
	metadata := term.get("setFilter")
	if metadata == nil {
		return linkSetFilter{}, false
	}
	id, mode, values := metadata.get("id"), metadata.get("mode"), metadata.get("values")
	if !id.isString() || !mode.isString() || !values.isArray() {
		return linkSetFilter{}, false
	}
	if index > 0 && sameJS(setFilterID(where[index-1]), id) {
		return linkSetFilter{}, false
	}
	predicates := predicatesOfJS(term)
	if len(predicates) == 0 {
		return linkSetFilter{}, false
	}
	field := predicates[0].get("field")
	if !field.isString() || field.s == "" {
		return linkSetFilter{}, false
	}
	target := "scalar"
	for _, clause := range predicates {
		if op := clause.get("op"); op.isString() && op.s == "includes" {
			target = "array"
		}
	}
	if mode.s != "any" && mode.s != "none" {
		target = "array"
	}
	var list []string
	for _, value := range values.a {
		if !value.isString() {
			return linkSetFilter{}, false
		}
		list = append(list, value.s)
	}
	expected := createLinkSetFilter(field.s, mode.s, list, id.s, target)
	if len(expected) == 0 {
		return linkSetFilter{}, false
	}
	for offset, want := range expected {
		if index+offset >= len(where) {
			return linkSetFilter{}, false
		}
		actual := where[index+offset]
		if !sameJS(actual.get("setFilter"), want.get("setFilter")) || !sameJS(stripLinkSetFilter(actual), stripLinkSetFilter(want)) {
			return linkSetFilter{}, false
		}
	}
	if next := index + len(expected); next < len(where) && sameJS(setFilterID(where[next]), id) {
		return linkSetFilter{}, false
	}
	return linkSetFilter{field: field.s, mode: mode.s, id: id.s, target: target, values: list, count: len(expected)}, true
}

// ---- LinkQuery ⇄ QueryState -------------------------------------------------

func parseLinkJSON(raw json.RawMessage, member string) (*jsValue, error) {
	value, err := parseJSValue(whatwgUTF8(raw))
	if err != nil {
		return nil, linkError(QueryLinkInvalid, "Invalid "+member+" JSON.")
	}
	return value, nil
}

func linkClauseJS(field, op, value string, negated bool) *jsValue {
	clause := jsObj().set("field", jsStr(field)).set("op", jsStr(op)).set("value", jsStr(value))
	if negated {
		clause.set("negated", jsBoolValue(true))
	}
	return clause
}

// jsState is the QueryState q denotes, with members in normalized order.
func (q LinkQuery) jsState() (*jsValue, error) {
	state := jsObj()
	columns := jsArr()
	for _, column := range q.Select {
		item := jsObj().set("field", jsStr(column.Field))
		if column.Width != 0 {
			item.set("width", jsNum(float64(column.Width)))
		}
		if len(column.Display) > 0 {
			display, err := parseLinkJSON(column.Display, "column display")
			if err != nil {
				return nil, err
			}
			item.set("display", display)
		}
		columns.a = append(columns.a, item)
	}
	state.set("select", columns)
	where := jsArr()
	for _, term := range q.Where {
		var item *jsValue
		if term.IsGroup() {
			members := jsArr()
			for _, clause := range term.Any {
				members.a = append(members.a, linkClauseJS(clause.Field, clause.Op, clause.Value, clause.Negated))
			}
			item = jsObj().set("any", members)
		} else {
			item = linkClauseJS(term.Field, term.Op, term.Value, term.Negated)
		}
		if term.SetFilter != nil {
			item.set("setFilter", jsObj().
				set("id", jsStr(term.SetFilter.ID)).
				set("mode", jsStr(term.SetFilter.Mode)).
				set("values", jsStrings(term.SetFilter.Values)))
		}
		where.a = append(where.a, item)
	}
	state.set("where", where)
	orderBy := jsArr()
	for _, term := range q.OrderBy {
		item := jsObj().set("field", jsStr(term.Field)).set("dir", jsStr(term.Dir))
		if term.Nulls != "" {
			item.set("nulls", jsStr(term.Nulls))
		}
		if term.Extract != nil {
			item.set("extract", jsObj().set("regex", jsStr(term.Extract.Regex)))
		}
		orderBy.a = append(orderBy.a, item)
	}
	state.set("orderBy", orderBy)
	if q.Limit != 0 {
		state.set("limit", jsNum(float64(q.Limit)))
	}
	state.set("offset", jsNum(float64(q.Offset)))
	if q.FitToScreen {
		state.set("fitToScreen", jsBoolValue(true))
	}
	if len(q.Grouping) > 0 {
		grouping, err := parseLinkJSON(q.Grouping, "grouping")
		if err != nil {
			return nil, err
		}
		state.set("grouping", grouping)
	}
	if q.Aggregations != nil {
		aggregations := jsArr()
		for _, raw := range q.Aggregations {
			aggregation, err := parseLinkJSON(raw, "aggregation")
			if err != nil {
				return nil, err
			}
			aggregations.a = append(aggregations.a, aggregation)
		}
		state.set("aggregations", aggregations)
	}
	if len(q.ItemDetails) > 0 {
		details, err := parseLinkJSON(q.ItemDetails, "itemDetails")
		if err != nil {
			return nil, err
		}
		state.set("itemDetails", details)
	}
	return state, nil
}

func rawJS(v *jsValue) json.RawMessage { return json.RawMessage(stringifyJS(v)) }

func linkSetFilterFrom(v *jsValue) (*SetFilterMetadata, error) {
	if v == nil {
		return nil, nil
	}
	mode := v.get("mode")
	if !mode.isString() {
		// normalizeQueryState keeps any mode whose String() is valid, such as
		// ["any"]; encodeQuery then throws on it. Refuse it here instead.
		return nil, linkError(QueryLinkInvalid, "Invalid set filter mode in query link.")
	}
	metadata := &SetFilterMetadata{ID: v.get("id").s, Mode: mode.s, Values: []string{}}
	for _, value := range v.get("values").a {
		metadata.Values = append(metadata.Values, value.s)
	}
	return metadata, nil
}

func linkQueryFromState(state *jsValue) (LinkQuery, error) {
	q := LinkQuery{
		Select:  []LinkColumn{},
		Where:   []WhereTerm{},
		OrderBy: []OrderBy{},
		Limit:   int64(state.get("limit").n),
		Offset:  int(state.get("offset").n),
	}
	for _, column := range state.get("select").a {
		item := LinkColumn{Field: column.get("field").s}
		if width := column.get("width"); width != nil {
			item.Width = int(width.n)
		}
		if display := column.get("display"); display != nil {
			item.Display = rawJS(display)
		}
		q.Select = append(q.Select, item)
	}
	clause := func(v *jsValue) WhereClause {
		negated := v.get("negated")
		return WhereClause{Field: v.get("field").s, Op: v.get("op").s, Value: v.get("value").s, Negated: negated != nil && negated.b}
	}
	for _, term := range state.get("where").a {
		var item WhereTerm
		if any := term.get("any"); any != nil {
			item.Any = []WhereClause{}
			for _, member := range any.a {
				item.Any = append(item.Any, clause(member))
			}
		} else {
			literal := clause(term)
			item = WhereTerm{Field: literal.Field, Op: literal.Op, Value: literal.Value, Negated: literal.Negated}
		}
		metadata, err := linkSetFilterFrom(term.get("setFilter"))
		if err != nil {
			return LinkQuery{}, err
		}
		item.SetFilter = metadata
		q.Where = append(q.Where, item)
	}
	for _, term := range state.get("orderBy").a {
		item := OrderBy{Field: term.get("field").s, Dir: term.get("dir").s}
		if nulls := term.get("nulls"); nulls != nil {
			item.Nulls = nulls.s
		}
		if extract := term.get("extract"); extract != nil {
			item.Extract = &RegexExtract{Regex: extract.get("regex").s}
		}
		q.OrderBy = append(q.OrderBy, item)
	}
	q.FitToScreen = state.get("fitToScreen") != nil
	if grouping := state.get("grouping"); grouping != nil {
		q.Grouping = rawJS(grouping)
	}
	if aggregations := state.get("aggregations"); aggregations != nil {
		for _, aggregation := range aggregations.a {
			q.Aggregations = append(q.Aggregations, rawJS(aggregation))
		}
	}
	if details := state.get("itemDetails"); details != nil {
		q.ItemDetails = rawJS(details)
	}
	return q, nil
}
