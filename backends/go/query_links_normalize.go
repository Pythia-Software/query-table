package querytable

// A port of normalizeQueryState from @pythia-software/query-table-core
// (packages/core/src/query.ts, metricNormalize.ts, cellDisplay.ts and
// normalizePropertyView in properties.ts). Each function keeps the name and
// order of checks of its TypeScript original, because the order in which
// members are assigned is the order in which they are encoded, and the order
// of diagnostics is part of the state. Keep the two in step: the shared
// fixtures in schema/fixtures/query-links.json fail on any divergence.

import (
	"math"
	"regexp"
	"strconv"
)

const (
	maxSafeInteger     = 1<<53 - 1
	linkDefaultLimit   = 100
	linkMaxFieldName   = 256
	linkMaxFilterValue = 10_000
	linkMaxLabel       = 1_000
	linkMinColumnWidth = 24
	linkMaxColumnWidth = 2_000
	linkMaxSummaries   = 64
	linkMaxLinkParams  = 50
	linkMaxProperties  = 200
	linkMaxURLTemplate = 8_000
)

func stringSet(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

var (
	linkFilterOps = stringSet("=", "!=", ">", ">=", "<", "<=", "contains", "starts_with", "ends_with",
		"matches_regex", "not_matches_regex", "length_gt", "length_lt", "length_eq", "includes", "is_null", "is_not_null")
	linkAggOps      = stringSet("count", "count_distinct", "sum", "avg", "min", "max")
	linkSetModes    = stringSet("any", "all", "none", "empty")
	linkQueryFacets = stringSet("filters", "columns", "order", "grouping", "metrics", "limit")
	sortDirections  = stringSet("asc", "desc")
	nullPlacements  = stringSet("first", "last")
	linkPatchKeys   = []string{"select", "where", "orderBy", "limit", "aggregations", "grouping", "fitToScreen"}
)

func boundedJSString(v *jsValue, maxLength int) (string, bool) {
	if !v.isString() {
		return "", false
	}
	n := jsLength(v.s)
	return v.s, n > 0 && n <= maxLength
}

func boundedJSInteger(v *jsValue, fallback, min, max float64) float64 {
	if !jsIsFinite(v) {
		return fallback
	}
	return math.Max(min, math.Min(max, jsRound(v.n)))
}

func firstN(items []*jsValue, n int) []*jsValue {
	if len(items) > n {
		return items[:n]
	}
	return items
}

func includesString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func jsUniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

// isStringIn is `typeof v === "string" && list.includes(v)`.
func isStringIn(v *jsValue, set map[string]bool) bool { return v.isString() && set[v.s] }

// predicatesOfJS is predicatesOf: a group's members, or the term itself.
func predicatesOfJS(term *jsValue) []*jsValue {
	if any := term.get("any"); any.isArray() {
		return any.a
	}
	return []*jsValue{term}
}

func predicateCount(terms []*jsValue) int {
	n := 0
	for _, term := range terms {
		n += len(predicatesOfJS(term))
	}
	return n
}

// suppliedPredicates counts raw terms as normalizeMetricWhere does: a group
// counts its members, anything else one.
func suppliedPredicates(terms []*jsValue, emptyGroupCountsOne bool) int {
	n := 0
	for _, term := range terms {
		if any := term.get("any"); any.isArray() {
			if emptyGroupCountsOne && len(any.a) == 0 {
				n++
			} else {
				n += len(any.a)
			}
		} else {
			n++
		}
	}
	return n
}

func normalizeLinkClause(item *jsValue) *jsValue {
	if !item.isRecord() {
		return nil
	}
	field, fieldOK := boundedJSString(item.get("field"), linkMaxFieldName)
	value := item.get("value")
	valueOK := value.isString() && jsLength(value.s) <= linkMaxFilterValue
	op := item.get("op")
	if !fieldOK || !isStringIn(op, linkFilterOps) || !valueOK {
		return nil
	}
	clause := jsObj().set("field", jsStr(field)).set("op", jsStr(op.s)).set("value", jsStr(value.s))
	if negated := item.get("negated"); negated != nil && negated.kind == jsBool && negated.b {
		clause.set("negated", jsBoolValue(true))
	}
	return clause
}

func normalizeLinkSetFilter(item *jsValue) *jsValue {
	if !item.isRecord() {
		return nil
	}
	id, idOK := boundedJSString(item.get("id"), linkMaxFieldName)
	values := item.get("values")
	if !idOK || !linkSetModes[jsToString(item.get("mode"))] || !values.isArray() {
		return nil
	}
	if len(values.a) > MaxWhereClauses {
		return nil
	}
	for _, value := range values.a {
		if !value.isString() || jsLength(value.s) > linkMaxFilterValue {
			return nil
		}
	}
	return jsObj().set("id", jsStr(id)).set("mode", item.get("mode")).set("values", jsArr(values.a...))
}

func normalizeLinkWhereTerms(input []*jsValue) []*jsValue {
	where := []*jsValue{}
	budget := MaxWhereClauses
	for _, item := range input {
		if budget <= 0 {
			break
		}
		start := len(where)
		if any := item.get("any"); item.isRecord() && any.isArray() {
			var members []*jsValue
			for _, inner := range any.a {
				if budget <= 0 {
					break
				}
				if clause := normalizeLinkClause(inner); clause != nil {
					members = append(members, clause)
					budget--
				}
			}
			if len(members) == 1 {
				where = append(where, members[0])
			} else if len(members) > 1 {
				where = append(where, jsObj().set("any", jsArr(members...)))
			}
		} else if clause := normalizeLinkClause(item); clause != nil {
			where = append(where, clause)
			budget--
		}
		if len(where) > start && item.isRecord() {
			if metadata := normalizeLinkSetFilter(item.get("setFilter")); metadata != nil {
				where[start].set("setFilter", metadata)
			}
		}
	}
	return where
}

func normalizeLinkQueryState(input *jsValue) *jsValue { return normalizeLinkQuery(input, true) }

// normalizeLinkQuery is normalizeQuery with EMPTY_QUERY as the fallback, the
// only fallback the link codec uses. `links` is false inside a link's patch.
func normalizeLinkQuery(input *jsValue, links bool) *jsValue {
	raw := input
	if !raw.isRecord() {
		raw = jsObj()
	}

	selectList := jsArr()
	if items := raw.get("select"); items.isArray() {
		for _, item := range firstN(items.a, MaxSelectColumns) {
			if !item.isRecord() {
				continue
			}
			field, ok := boundedJSString(item.get("field"), linkMaxFieldName)
			if !ok {
				continue
			}
			column := jsObj().set("field", jsStr(field))
			if width := item.get("width"); jsIsFinite(width) {
				column.set("width", jsNum(boundedJSInteger(width, linkMinColumnWidth, linkMinColumnWidth, linkMaxColumnWidth)))
			}
			if display := item.get("display"); display != nil {
				if parsed, err := parseLinkCellDisplay(display, "column "+field+" display"); err == "" {
					column.set("display", parsed)
				}
			}
			selectList.a = append(selectList.a, column)
		}
	}

	where := jsArr()
	if terms := raw.get("where"); terms.isArray() {
		where.a = normalizeLinkWhereTerms(terms.a)
	}

	orderBy := jsArr()
	if items := raw.get("orderBy"); items.isArray() {
		for _, item := range firstN(items.a, MaxOrderByTerms) {
			if !item.isRecord() {
				continue
			}
			field, ok := boundedJSString(item.get("field"), linkMaxFieldName)
			dir := item.get("dir")
			if !ok || !(dir.isString() && (dir.s == "asc" || dir.s == "desc")) {
				continue
			}
			term := jsObj().set("field", jsStr(field)).set("dir", jsStr(dir.s))
			if nulls := item.get("nulls"); nulls.isString() && (nulls.s == "first" || nulls.s == "last") {
				term.set("nulls", jsStr(nulls.s))
			}
			if extract := item.get("extract"); extract.isRecord() {
				if regex := extract.get("regex"); regex.isString() && jsLength(regex.s) <= linkMaxFilterValue {
					term.set("extract", jsObj().set("regex", jsStr(regex.s)))
				}
			}
			orderBy.a = append(orderBy.a, term)
		}
	}

	out := jsObj().
		set("select", selectList).
		set("where", where).
		set("orderBy", orderBy).
		set("limit", jsNum(boundedJSInteger(raw.get("limit"), linkDefaultLimit, 1, maxSafeInteger))).
		set("offset", jsNum(boundedJSInteger(raw.get("offset"), 0, 0, MaxQueryOffset)))

	if fit := raw.get("fitToScreen"); fit != nil && fit.kind == jsBool && fit.b {
		out.set("fitToScreen", jsBoolValue(true))
	}

	if grouping := raw.get("grouping"); !grouping.isNullish() {
		out.set("grouping", normalizeLinkGrouping(grouping, links))
	}

	if items := raw.get("aggregations"); items.isArray() {
		aggregations := jsArr()
		for _, item := range firstN(items.a, MaxAggregations) {
			if aggregation := normalizeLinkAggregation(item); aggregation != nil {
				aggregations.a = append(aggregations.a, aggregation)
			}
		}
		if len(aggregations.a) > 0 {
			out.set("aggregations", aggregations)
		}
	}

	if details := normalizeLinkItemDetails(raw.get("itemDetails")); details != nil {
		out.set("itemDetails", details)
	}
	return out
}

func appendDiagnostic(target *jsValue, message string) {
	diagnostics := jsArr()
	if existing := target.get("diagnostics"); existing.isArray() {
		diagnostics.a = append(diagnostics.a, existing.a...)
	}
	diagnostics.a = append(diagnostics.a, jsStr(message))
	target.set("diagnostics", diagnostics)
}

func normalizeLinkAggregation(item *jsValue) *jsValue {
	if !item.isRecord() {
		return nil
	}
	id, ok := boundedJSString(item.get("id"), linkMaxFieldName)
	if !ok {
		return nil
	}
	op := item.get("op")
	validOp := isStringIn(op, linkAggOps)
	rawGroupsValue := item.get("groupBy")
	var rawGroups []*jsValue
	if rawGroupsValue.isArray() {
		rawGroups = rawGroupsValue.a
	}
	groupBy := jsArr()
	for _, field := range firstN(rawGroups, MaxGroupByFields) {
		if name, ok := boundedJSString(field, linkMaxFieldName); ok {
			groupBy.a = append(groupBy.a, jsStr(name))
		}
	}
	opValue := jsStr("count")
	if validOp {
		opValue = jsStr(op.s)
	}
	aggregation := jsObj().set("id", jsStr(id)).set("op", opValue).set("groupBy", groupBy)
	field, fieldOK := boundedJSString(item.get("field"), linkMaxFieldName)
	label, labelOK := boundedJSString(item.get("label"), linkMaxLabel)
	if fieldOK {
		aggregation.set("field", jsStr(field))
	}
	if labelOK {
		aggregation.set("label", jsStr(label))
	}
	options := normalizeLinkMetricOptions(item)
	for _, key := range options.o.keys() {
		aggregation.set(key, options.o.values[key])
	}
	metricWhere, invalidWhere := normalizeLinkMetricWhere(item.get("where"))
	if metricWhere != nil {
		aggregation.set("where", metricWhere)
	}
	if invalidWhere {
		appendDiagnostic(aggregation, "Invalid metric filter.")
	}
	if !rawGroupsValue.isArray() || len(rawGroups) > MaxGroupByFields || len(groupBy.a) != len(rawGroups) {
		appendDiagnostic(aggregation, "Invalid metric grouping fields or grouping budget exceeded.")
	}
	unsupported := item.get("unsupportedOp")
	if unsupported.isNullish() {
		unsupported = nil
		if !validOp {
			unsupported = op
		}
	}
	if name, ok := boundedJSString(unsupported, linkMaxFieldName); ok {
		aggregation.set("unsupportedOp", jsStr(name))
	}
	if item.get("field") != nil && !fieldOK {
		appendDiagnostic(aggregation, "Invalid metric measure field.")
	}
	if !validOp && !item.get("expression").isString() {
		appendDiagnostic(aggregation, "Unsupported aggregate operation.")
	}
	return aggregation
}

// normalizeLinkMetricWhere returns the normalized terms (nil when none) and
// whether any supplied predicate was lost.
func normalizeLinkMetricWhere(value *jsValue) (*jsValue, bool) {
	if value == nil {
		return nil, false
	}
	if !value.isArray() {
		return nil, true
	}
	where := normalizeLinkWhereTerms(value.a)
	invalid := suppliedPredicates(value.a, false) != predicateCount(where)
	if len(where) == 0 {
		return nil, invalid
	}
	return jsArr(where...), invalid
}

// ---- normalizeMetricOptions ----------------------------------------------

type optionKind uint8

const (
	optionEnum optionKind = iota
	optionString
	optionBoolean
	optionInteger
	optionPositiveInteger
	optionNumber
)

type optionSpec struct {
	key    string
	kind   optionKind
	values map[string]bool
}

func enumOption(key string, values ...string) optionSpec {
	return optionSpec{key: key, kind: optionEnum, values: stringSet(values...)}
}

var (
	metricTopOptions = []optionSpec{
		{key: "expression", kind: optionString},
		{key: "expressionY", kind: optionString},
		enumOption("scope", "allMatching", "shownRows"),
		{key: "groupLimit", kind: optionInteger},
		{key: "minCount", kind: optionPositiveInteger},
		enumOption("share", "total", "group0"),
	}
	metricWindowOptions = []optionSpec{
		enumOption("reduce", "total", "mean"),
		enumOption("partial", "omit", "include"),
	}
	metricDateOptions = []optionSpec{
		{key: "field", kind: optionString},
		enumOption("interval", "hour", "day", "week", "month", "year"),
		{key: "timeZone", kind: optionString},
		{key: "includeEmpty", kind: optionBoolean},
		enumOption("range", "query", "observed", "custom"),
		{key: "start", kind: optionString},
		{key: "end", kind: optionString},
		enumOption("partialIntervals", "include", "exclude"),
	}
	metricDisplayOptions = []optionSpec{
		enumOption("kind", "auto", "value", "table", "list", "bar-horizontal", "bar-vertical", "line", "pie", "donut",
			"scatter", "box", "histogram"),
		{key: "valueLabel", kind: optionString},
		{key: "xLabel", kind: optionString},
		{key: "yLabel", kind: optionString},
		enumOption("legendPosition", "left", "right", "top", "bottom", "none"),
		{key: "maxGroups", kind: optionPositiveInteger},
		{key: "showOther", kind: optionBoolean},
		{key: "boxMean", kind: optionBoolean},
	}
	metricScaleOptions = []optionSpec{
		enumOption("mode", "linear", "log"),
		{key: "min", kind: optionNumber},
		{key: "max", kind: optionNumber},
	}
	metricFormatOptions = []optionSpec{
		enumOption("kind", "number", "percent", "duration", "date", "time", "datetime"),
		{key: "decimals", kind: optionInteger},
		enumOption("sourceUnit", "milliseconds", "seconds", "minutes", "hours", "days", "iso", "epochSeconds",
			"epochMilliseconds", "secondsOfDay", "millisecondsOfDay"),
		enumOption("style", "human", "long", "clock", "custom", "iso"),
		{key: "pattern", kind: optionString},
		{key: "timeZone", kind: optionString},
	}
	metricListOptions = []optionSpec{
		{key: "showBars", kind: optionBoolean},
		{key: "useGroupColors", kind: optionBoolean},
		{key: "showValues", kind: optionBoolean},
		enumOption("barPosition", "inline", "below"),
		{key: "maxLabelLines", kind: optionPositiveInteger},
	}
	metricPivotOptions = []optionSpec{
		{key: "swap", kind: optionBoolean},
		enumOption("rowDir", "asc", "desc"),
		enumOption("columnDir", "asc", "desc"),
	}
	metricDistributionOptions = []optionSpec{
		enumOption("kind", "box", "histogram"),
		{key: "input", kind: optionString},
		enumOption("whiskers", "minmax", "tukey"),
		{key: "bins", kind: optionInteger},
	}
	metricLayoutOptions = []optionSpec{
		{key: "widthRem", kind: optionInteger},
		{key: "heightRem", kind: optionInteger},
		{key: "minWidthRem", kind: optionInteger},
		{key: "minHeightRem", kind: optionInteger},
	}
	metricSortKey = regexp.MustCompile(`^(value|y|count|samples|group(?:0|[1-9][0-9]?))$`)
)

type metricNormalizer struct{ diagnostics []string }

func (m *metricNormalizer) copy(input *jsValue, specs []optionSpec) *jsValue {
	result := jsObj()
	for _, spec := range specs {
		v := input.get(spec.key)
		if v == nil {
			continue
		}
		var ok bool
		switch spec.kind {
		case optionString:
			ok = v.isString() && jsLength(v.s) <= 10000
		case optionNumber:
			ok = jsIsFinite(v)
		case optionBoolean:
			ok = v.kind == jsBool
		case optionInteger, optionPositiveInteger:
			min := 0.0
			if spec.kind == optionPositiveInteger {
				min = 1
			}
			ok = jsIsSafeInteger(v) && v.n >= min && v.n <= 1000000
		default:
			ok = isStringIn(v, spec.values)
		}
		if ok {
			result.set(spec.key, v)
		} else {
			m.diagnostics = append(m.diagnostics, "Invalid metric "+spec.key+".")
		}
	}
	return result
}

func normalizeLinkMetricOptions(raw *jsValue) *jsValue {
	m := &metricNormalizer{}
	out := m.copy(raw, metricTopOptions)
	if window := raw.get("window"); window != nil {
		if window.isRecord() {
			w := m.copy(window, metricWindowOptions)
			periods := window.get("periods")
			if (periods.isString() && periods.s == "all") || (jsIsSafeInteger(periods) && periods.n >= 0 && periods.n <= 1000000) {
				w.set("periods", periods)
			} else {
				m.diagnostics = append(m.diagnostics, "Invalid metric window.")
			}
			out.set("window", w)
		} else {
			m.diagnostics = append(m.diagnostics, "Invalid metric window.")
		}
	}
	if dateGrouping := raw.get("dateGrouping"); dateGrouping != nil {
		if dateGrouping.isRecord() {
			d := m.copy(dateGrouping, metricDateOptions)
			field := d.get("field")
			includeEmpty := d.get("includeEmpty")
			if !field.isString() || field.s == "" || jsLength(field.s) > 256 || !d.get("interval").truthy() ||
				includeEmpty == nil || includeEmpty.kind != jsBool || !d.get("range").truthy() {
				m.diagnostics = append(m.diagnostics, "Invalid metric date grouping.")
			}
			out.set("dateGrouping", d)
		} else {
			m.diagnostics = append(m.diagnostics, "Invalid metric date grouping.")
		}
	}
	if display := raw.get("display"); display != nil {
		if display.isRecord() {
			if !display.get("kind").isString() {
				m.diagnostics = append(m.diagnostics, "Invalid metric display kind.")
			}
			d := m.copy(display, metricDisplayOptions)
			for _, key := range []string{"xScale", "yScale"} {
				if scale := display.get(key); scale.isRecord() {
					d.set(key, m.copy(scale, metricScaleOptions))
				} else if scale != nil {
					m.diagnostics = append(m.diagnostics, "Invalid metric "+key+".")
				}
			}
			for _, key := range []string{"format", "xFormat", "yFormat"} {
				if format := display.get(key); format.isRecord() {
					d.set(key, m.copy(format, metricFormatOptions))
				}
			}
			if list := display.get("list"); list.isRecord() {
				d.set("list", m.copy(list, metricListOptions))
			}
			if pivot := display.get("pivot"); pivot.isRecord() {
				d.set("pivot", m.copy(pivot, metricPivotOptions))
			}
			withKind := jsObj().set("kind", jsStr("auto"))
			for _, key := range d.o.keys() {
				withKind.set(key, d.o.values[key])
			}
			out.set("display", withKind)
		} else {
			m.diagnostics = append(m.diagnostics, "Invalid metric display.")
		}
	}
	if distribution := raw.get("distribution"); distribution != nil {
		if distribution.isRecord() {
			out.set("distribution", m.copy(distribution, metricDistributionOptions))
		} else {
			m.diagnostics = append(m.diagnostics, "Invalid metric distribution.")
		}
	}
	if layout := raw.get("layout"); layout.isRecord() {
		l := m.copy(layout, metricLayoutOptions)
		for _, key := range []string{"widthRem", "heightRem", "minWidthRem", "minHeightRem"} {
			value := 1.0
			if existing := l.get(key); existing != nil {
				value = existing.n
			}
			l.set(key, jsNum(math.Max(1, math.Min(1000, value))))
		}
		l.set("widthRem", jsNum(math.Max(l.get("widthRem").n, l.get("minWidthRem").n)))
		l.set("heightRem", jsNum(math.Max(l.get("heightRem").n, l.get("minHeightRem").n)))
		out.set("layout", l)
	}
	sort := raw.get("sort")
	if sort != nil && !sort.isArray() {
		m.diagnostics = append(m.diagnostics, "Invalid metric sort.")
	}
	if sort.isArray() {
		terms := jsArr()
		for _, s := range firstN(sort.a, 20) {
			key := s.get("key")
			if !s.isRecord() || !key.isString() || !metricSortKey.MatchString(key.s) ||
				!sortDirections[jsToString(s.get("dir"))] {
				m.diagnostics = append(m.diagnostics, "Invalid metric sort.")
				continue
			}
			terms.a = append(terms.a, m.copy(s, []optionSpec{
				enumOption("key", key.s),
				enumOption("dir", "asc", "desc"),
				enumOption("nulls", "first", "last"),
			}))
		}
		out.set("sort", terms)
	}
	if diagnostics := raw.get("diagnostics"); diagnostics.isArray() {
		kept := 0
		for _, item := range diagnostics.a {
			if kept == 20 {
				break
			}
			if item.isString() && jsLength(item.s) <= 1000 {
				m.diagnostics = append(m.diagnostics, item.s)
				kept++
			}
		}
	}
	if len(m.diagnostics) > 0 {
		out.set("diagnostics", jsStrings(jsUniqueStrings(m.diagnostics)))
	}
	return out
}

// ---- parseCellDisplay -----------------------------------------------------

type displayRule struct {
	kind    string // "enum", "range", "string", "boolean", "labels", "tones"
	values  []string
	min     float64
	max     float64
	display string // the TypeScript rule as its error message prints it
}

func displayEnum(values ...string) displayRule { return displayRule{kind: "enum", values: values} }
func displayRange(min, max float64) displayRule {
	return displayRule{kind: "range", min: min, max: max}
}

var cellDisplayOptions = func() map[string]map[string]displayRule {
	calendar := func(units ...string) map[string]displayRule {
		return map[string]displayRule{
			"style":      displayEnum("human", "iso", "custom"),
			"pattern":    {kind: "string"},
			"timeZone":   {kind: "string"},
			"locale":     {kind: "string"},
			"sourceUnit": displayEnum(units...),
		}
	}
	numbers := map[string]displayRule{"decimals": displayRange(0, 20), "locale": {kind: "string"}}
	return map[string]map[string]displayRule{
		"json": {
			"encoding":       displayEnum("auto", "value", "json", "escaped"),
			"maxDecodeDepth": displayRange(1, 8),
			"previewLength":  displayRange(20, 500),
			"expandDepth":    displayRange(0, 8),
		},
		"date":     calendar("iso", "epochSeconds", "epochMilliseconds"),
		"datetime": calendar("iso", "epochSeconds", "epochMilliseconds"),
		"time":     calendar("iso", "epochSeconds", "epochMilliseconds", "secondsOfDay", "millisecondsOfDay"),
		"duration": {
			"sourceUnit": displayEnum("milliseconds", "seconds", "minutes", "hours", "days"),
			"style":      displayEnum("human", "long", "clock", "custom"),
			"pattern":    {kind: "string"},
			"decimals":   displayRange(0, 20),
		},
		"number":  numbers,
		"percent": numbers,
		"chip":    {"labels": {kind: "labels"}, "tones": {kind: "tones"}},
		"text":    {"truncate": {kind: "boolean"}, "lines": displayRange(1, 20)},
	}
}()

var chipTones = stringSet("neutral", "success", "warning", "danger")

// parseLinkCellDisplay returns the display, or the TypeScript error message.
func parseLinkCellDisplay(raw *jsValue, context string) (*jsValue, string) {
	fail := func(reason string) (*jsValue, string) { return nil, context + ": " + reason }
	if !raw.isRecord() {
		return fail("expected an object")
	}
	kind := raw.get("kind")
	if !kind.isString() {
		return fail("unsupported kind")
	}
	allowed, ok := cellDisplayOptions[kind.s]
	if !ok {
		return fail("unsupported kind")
	}
	for _, key := range raw.o.keys() {
		if key == "kind" {
			continue
		}
		value := raw.o.values[key]
		rule, ok := allowed[key]
		if !ok {
			return fail("unsupported option " + key)
		}
		switch rule.kind {
		case "range":
			if !jsIsInteger(value) || value.n < rule.min || value.n > rule.max {
				return fail(key + " must be an integer from " + formatJSNumber(rule.min) + " to " + formatJSNumber(rule.max))
			}
		case "enum":
			if !value.isString() || !includesString(rule.values, value.s) {
				return fail("unsupported " + key)
			}
		case "labels", "tones":
			if !value.isRecord() {
				return fail("invalid " + key + " map")
			}
			for _, entry := range value.o.keys() {
				item := value.o.values[entry]
				if !item.isString() || (rule.kind == "tones" && !chipTones[item.s]) {
					return fail("invalid " + key + " map")
				}
			}
		case "string":
			if !value.isString() {
				return fail(key + " must be string")
			}
		case "boolean":
			if value.kind != jsBool {
				return fail(key + " must be boolean")
			}
		}
		if key == "pattern" && jsLength(value.s) > 160 {
			return fail("pattern must be at most 160 characters")
		}
	}
	out := raw.spread()
	for _, key := range []string{"labels", "tones"} {
		if value := raw.get(key); value != nil {
			out.set(key, value.spread())
		}
	}
	return out, ""
}

// ---- normalizePropertyView ------------------------------------------------

func propertyString(v *jsValue, maxLength int) bool {
	_, ok := boundedJSString(v, maxLength)
	return ok
}

func validPropertyDecimals(v *jsValue) bool {
	return jsIsInteger(v) && v.n >= 0 && v.n <= 20
}

var (
	propertySimpleKinds  = stringSet("text", "code", "boolean", "chips")
	propertyMetricKinds  = stringSet("number", "percent", "duration", "date", "time", "datetime")
	propertyRelativeUnit = stringSet("iso", "epochSeconds", "epochMilliseconds")
	propertySourceUnits  = stringSet("milliseconds", "seconds", "minutes", "hours", "days", "iso", "epochSeconds",
		"epochMilliseconds", "secondsOfDay", "millisecondsOfDay")
	propertyStyles   = stringSet("human", "long", "clock", "custom", "iso")
	propertyCurrency = regexp.MustCompile(`^[A-Z]{3}$`)
)

func normalizeLinkPropertyFormat(input *jsValue) *jsValue {
	if !input.isRecord() {
		return nil
	}
	kind := input.get("kind")
	if kind.isString() && (kind.s == "json" || kind.s == "chip") {
		display, err := parseLinkCellDisplay(input, "cell display")
		if err != "" {
			return nil
		}
		return display
	}
	decimals := input.get("decimals")
	if decimals != nil && !validPropertyDecimals(decimals) {
		return nil
	}
	if propertySimpleKinds[jsToString(kind)] {
		return jsObj().set("kind", kind)
	}
	sourceUnit := input.get("sourceUnit")
	if kind.isString() && kind.s == "relative" {
		if sourceUnit != nil && !propertyRelativeUnit[jsToString(sourceUnit)] {
			return nil
		}
		out := jsObj().set("kind", kind)
		if sourceUnit.truthy() {
			out.set("sourceUnit", sourceUnit)
		}
		return out
	}
	if kind.isString() && kind.s == "currency" {
		currency := input.get("currency")
		if !currency.isString() || !propertyCurrency.MatchString(currency.s) {
			return nil
		}
		out := jsObj().set("kind", kind).set("currency", currency)
		if validPropertyDecimals(decimals) {
			out.set("decimals", decimals)
		}
		return out
	}
	if !propertyMetricKinds[jsToString(kind)] {
		return nil
	}
	if sourceUnit != nil && !propertySourceUnits[jsToString(sourceUnit)] {
		return nil
	}
	style := input.get("style")
	if style != nil && !propertyStyles[jsToString(style)] {
		return nil
	}
	pattern := input.get("pattern")
	if pattern != nil && !propertyString(pattern, 1000) {
		return nil
	}
	timeZone := input.get("timeZone")
	if timeZone != nil && !propertyString(timeZone, 256) {
		return nil
	}
	out := jsObj().set("kind", kind)
	if validPropertyDecimals(decimals) {
		out.set("decimals", decimals)
	}
	if propertySourceUnits[jsToString(sourceUnit)] {
		out.set("sourceUnit", sourceUnit)
	}
	if propertyStyles[jsToString(style)] {
		out.set("style", style)
	}
	if propertyString(pattern, 1000) {
		out.set("pattern", pattern)
	}
	if propertyString(timeZone, 256) {
		out.set("timeZone", timeZone)
	}
	return out
}

func normalizeLinkPropertyView(input *jsValue) *jsValue {
	version := input.get("version")
	properties := input.get("properties")
	if !input.isRecord() || !version.isNumber() || version.n != 1 || !properties.isArray() {
		return nil
	}
	if len(properties.a) > linkMaxProperties {
		return nil
	}
	ids := map[string]bool{}
	list := jsArr()
	for _, item := range properties.a {
		id, field := item.get("id"), item.get("field")
		if !item.isRecord() || !propertyString(id, 256) || !propertyString(field, 256) || ids[id.s] {
			return nil
		}
		ids[id.s] = true
		property := jsObj().set("id", id).set("field", field)
		if label := item.get("label"); propertyString(label, 1000) {
			property.set("label", label)
		}
		if render := item.get("render"); propertyString(render, 256) {
			property.set("render", render)
		}
		if format := item.get("format"); format != nil {
			normalized := normalizeLinkPropertyFormat(format)
			if normalized == nil {
				return nil
			}
			property.set("format", normalized)
		}
		list.a = append(list.a, property)
	}
	out := jsObj().set("version", jsNum(1)).set("properties", list)
	if width := input.get("labelWidth"); jsIsFinite(width) {
		out.set("labelWidth", jsNum(math.Max(15, math.Min(75, jsRound(width.n)))))
	}
	return out
}

// tryPropertyView is the TypeScript `try { normalizePropertyView(view) }
// catch {}`: a view that throws, even while coercing a value to text, is
// ignored.
func tryPropertyView(view *jsValue) (normalized *jsValue) {
	if catchJS(func() { normalized = normalizeLinkPropertyView(view) }) {
		return nil
	}
	return normalized
}

var (
	itemDetailModes   = []string{"hover", "modal", "expand", "page"}
	itemPropertyModes = []string{"hover", "modal", "expand"}
)

func normalizeLinkItemDetails(raw *jsValue) *jsValue {
	modesValue := raw.get("modes")
	if !raw.isRecord() || !modesValue.isArray() {
		return nil
	}
	var modes []string
	for _, mode := range modesValue.a {
		if mode.isString() && includesString(itemDetailModes, mode.s) {
			modes = append(modes, mode.s)
		}
	}
	modes = jsUniqueStrings(modes)
	details := jsObj().set("modes", jsStrings(modes))
	if page := raw.get("page"); page.isRecord() {
		if template := page.get("urlTemplate"); template.isString() && jsLength(template.s) <= linkMaxURLTemplate {
			target := "_blank"
			if t := page.get("target"); t.isString() && t.s == "_self" {
				target = "_self"
			}
			details.set("page", jsObj().set("urlTemplate", template).set("target", jsStr(target)))
		}
	}
	if view := raw.get("view"); view != nil {
		if normalized := tryPropertyView(view); normalized != nil {
			details.set("view", normalized)
		}
	}
	if views := raw.get("views"); views.isRecord() {
		out := jsObj()
		for _, mode := range itemPropertyModes {
			if view := views.get(mode); view != nil {
				if normalized := tryPropertyView(view); normalized != nil {
					out.set(mode, normalized)
				}
			}
		}
		if out.o.size() > 0 {
			details.set("views", out)
		}
	}
	if active := raw.get("active"); active.isRecord() {
		mode := active.get("mode")
		id := active.get("id")
		if mode.isString() && (mode.s == "modal" || mode.s == "expand") && includesString(modes, mode.s) &&
			((id.isString() && id.s != "" && jsLength(id.s) <= 1000) || jsIsFinite(id)) {
			details.set("active", jsObj().set("id", id).set("mode", mode))
		}
	}
	return details
}

// ---- grouping -------------------------------------------------------------

const medianHint = ` (for a median, use op "formula" with expression "MEDIAN([field])")`

// asciiLowerEquals is `s.toLowerCase() === want` for an ASCII `want`. No
// non-ASCII character lowercases to an ASCII letter of "median", so ASCII
// folding is exact here.
func asciiLowerEquals(s, want string) bool {
	if len(s) != len(want) {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != want[i] {
			return false
		}
	}
	return true
}

func normalizeLinkGrouping(value *jsValue, links bool) *jsValue {
	raw := value
	if !raw.isRecord() {
		raw = jsObj()
	}
	var diagnostics []string
	fail := func(message string) { diagnostics = append(diagnostics, "Invalid grouping: "+message) }

	keysValue := raw.get("keys")
	var keys []string
	if keysValue.isArray() {
		for _, key := range firstN(keysValue.a, MaxGroupByFields) {
			if name, ok := boundedJSString(key, linkMaxFieldName); ok {
				keys = append(keys, name)
			}
		}
	}
	if !keysValue.isArray() || len(keys) == 0 || len(keys) != len(keysValue.a) || len(jsUniqueStrings(keys)) != len(keys) {
		fail("keys must list 1–" + strconv.Itoa(MaxGroupByFields) + " distinct field names.")
	}

	summaries := jsArr()
	summariesValue := raw.get("summaries")
	if !summariesValue.isArray() || len(summariesValue.a) > linkMaxSummaries {
		fail("summaries must be a list of at most 64 columns.")
	}
	summaryIDs := map[string]bool{}
	var items []*jsValue
	if summariesValue.isArray() {
		items = firstN(summariesValue.a, linkMaxSummaries)
	}
	for index, item := range items {
		id, idOK := boundedJSString(item.get("id"), linkMaxFieldName)
		name := "summary " + strconv.Itoa(index+1)
		if item.isRecord() && idOK {
			name = `summary "` + id + `"`
		}
		if !item.isRecord() || !idOK {
			fail(name + " needs an id of 1–256 characters.")
			continue
		}
		op := item.get("op")
		if !op.isString() || (!linkAggOps[op.s] && op.s != "row" && op.s != "formula" && (op.s != "link" || !links)) {
			if op.isString() && op.s == "link" {
				fail(name + " is a link column; a link's patch cannot contain link columns.")
			} else {
				text := jsToString(op)
				hint := ""
				if asciiLowerEquals(text, "median") {
					hint = medianHint
				}
				fail(name + " has unsupported op " + stringifyJS(jsStr(jsSlice(text, 40))) +
					"; use count, count_distinct, sum, avg, min, max, row, formula, or link" + hint + ".")
			}
			continue
		}
		column := jsObj().set("id", jsStr(id)).set("op", jsStr(op.s))
		if summaryIDs[id] {
			fail(name + " uses the same id as another summary column.")
		} else if includesString(keys, id) {
			fail(name + ` uses the same id as group key "` + id + `"; summary ids must differ from source field names.`)
		}
		summaryIDs[id] = true
		label := item.get("label")
		applyLabel := func() {
			if label != nil {
				if !label.isString() || jsLength(label.s) > linkMaxLabel {
					fail(name + " label must be text of at most 1,000 characters.")
				} else {
					column.set("label", label)
				}
			}
		}
		if op.s == "link" {
			if link := normalizeLinkSpec(item.get("link")); link != nil {
				column.set("link", link)
			}
			applyLabel()
			summaries.a = append(summaries.a, column)
			continue
		}
		if field := item.get("field"); field != nil {
			if _, ok := boundedJSString(field, linkMaxFieldName); !ok {
				fail(name + " has an invalid field name.")
			} else {
				column.set("field", field)
			}
		}
		if op.s == "formula" {
			if expression := item.get("expression"); !expression.isString() || jsLength(expression.s) > 10_000 {
				fail(name + " needs an expression of at most 10,000 characters.")
			} else {
				column.set("expression", expression)
			}
		}
		applyLabel()
		if display := item.get("display"); display != nil {
			if parsed, err := parseLinkCellDisplay(display, name+" display"); err != "" {
				fail(err + ".")
			} else {
				column.set("display", parsed)
			}
		}
		summaries.a = append(summaries.a, column)
	}

	representative := jsNullValue()
	if rep := raw.get("representative"); !rep.isNullish() {
		ordering := rep.get("orderBy")
		orderBy := jsArr()
		if !ordering.isArray() || len(ordering.a) == 0 || len(ordering.a) > 8 {
			fail("representative ordering must list 1–8 fields.")
		}
		var terms []*jsValue
		if ordering.isArray() {
			terms = firstN(ordering.a, 8)
		}
		for _, term := range terms {
			field, fieldOK := boundedJSString(term.get("field"), linkMaxFieldName)
			dir := term.get("dir")
			nulls := term.get("nulls")
			if !term.isRecord() || !fieldOK || !sortDirections[jsToString(dir)] ||
				(nulls != nil && !nullPlacements[jsToString(nulls)]) {
				fail(`each representative ordering term needs a field, dir "asc" or "desc", and optional nulls "first" or "last".`)
				continue
			}
			placement := "last"
			if nulls.isString() && nulls.s == "first" {
				placement = "first"
			}
			orderBy.a = append(orderBy.a, jsObj().set("field", jsStr(field)).set("dir", dir).set("nulls", jsStr(placement)))
		}
		representative = jsObj().set("orderBy", orderBy)
	}

	rawSource := raw.get("source")
	if !rawSource.isRecord() {
		fail("source must be the record query that is grouped.")
	} else if !rawSource.get("grouping").isNullish() {
		fail("only one grouping stage is supported; the source query cannot itself be grouped.")
	}
	source := rawSource.spread()
	source.del("grouping")
	if retained := raw.get("diagnostics"); retained.isArray() {
		for _, message := range firstN(retained.a, 20) {
			if message.isString() && message.s != "" {
				diagnostics = append(diagnostics, jsSlice(message.s, linkMaxLabel))
			} else {
				diagnostics = append(diagnostics, "Invalid grouping definition.")
			}
		}
	}
	normalizedSource := normalizeLinkQueryState(source)
	if where := source.get("where"); where.isArray() {
		if suppliedPredicates(where.a, false) != predicateCount(normalizedSource.get("where").a) {
			fail("source filters contain malformed predicates or exceed the predicate budget.")
		}
	}
	out := jsObj().
		set("keys", jsStrings(keys)).
		set("summaries", summaries).
		set("representative", representative).
		set("source", normalizedSource)
	if len(diagnostics) > 0 {
		out.set("diagnostics", jsStrings(jsUniqueStrings(diagnostics)))
	}
	return out
}

func normalizeLinkSpec(value *jsValue) *jsValue {
	to := value.get("to")
	if !value.isRecord() || !to.isRecord() {
		return nil
	}
	var label *jsValue
	rawLabel := value.get("label")
	if rawLabel.isString() && jsLength(rawLabel.s) <= linkMaxLabel {
		label = rawLabel
	} else if column, ok := boundedJSString(rawLabel.get("column"), linkMaxFieldName); rawLabel.isRecord() && ok {
		label = jsObj().set("column", jsStr(column))
	} else {
		return nil
	}
	kind := to.get("kind")
	if kind.isString() && kind.s == "template" {
		template := to.get("template")
		if !template.isString() || jsLength(template.s) > linkMaxURLTemplate {
			return nil
		}
		return jsObj().set("label", label).set("to", jsObj().set("kind", jsStr("template")).set("template", template))
	}
	target, targetOK := boundedJSString(to.get("target"), linkMaxFieldName)
	if !kind.isString() || kind.s != "query" || !targetOK {
		return nil
	}
	destination := jsObj().set("kind", jsStr("query")).set("target", jsStr(target))
	if base := to.get("base"); base != nil {
		if !base.isString() || (base.s != "source" && base.s != "empty") {
			return nil
		}
		destination.set("base", base)
	}
	if keyFilters := to.get("keyFilters"); keyFilters != nil {
		if keyFilters.kind != jsBool {
			return nil
		}
		destination.set("keyFilters", keyFilters)
	}
	if rawPatch := to.get("patch"); rawPatch != nil {
		patch := normalizeLinkPatch(rawPatch)
		if patch == nil {
			return nil
		}
		destination.set("patch", patch)
	}
	if params := to.get("params"); params != nil {
		if !params.isRecord() || params.o.size() > linkMaxLinkParams {
			return nil
		}
		for _, key := range params.o.keys() {
			item := params.o.values[key]
			if n := jsLength(key); n == 0 || n > linkMaxFieldName || !item.isString() || jsLength(item.s) > linkMaxFilterValue {
				return nil
			}
		}
		destination.set("params", params.spread())
	}
	return jsObj().set("label", label).set("to", destination)
}

func keptEveryTerm(supplied *jsValue, kept []*jsValue) bool {
	if !supplied.isArray() {
		return false
	}
	return suppliedPredicates(supplied.a, true) == predicateCount(kept)
}

func normalizeLinkPatch(value *jsValue) *jsValue {
	id, idOK := boundedJSString(value.get("id"), linkMaxFieldName)
	owns := value.get("owns")
	raw := value.get("query")
	if !value.isRecord() || !idOK || !owns.isArray() || !raw.isRecord() {
		return nil
	}
	if len(owns.a) > len(linkQueryFacets) {
		return nil
	}
	var facets []string
	for _, facet := range owns.a {
		if !isStringIn(facet, linkQueryFacets) {
			return nil
		}
		facets = append(facets, facet.s)
	}
	normalized := normalizeLinkQuery(raw, false)
	if grouping := normalized.get("grouping"); grouping != nil && grouping.get("diagnostics") != nil {
		return nil
	}
	if where := raw.get("where"); where != nil && !keptEveryTerm(where, normalized.get("where").a) {
		return nil
	}
	if aggregations := raw.get("aggregations"); aggregations != nil {
		kept := normalized.get("aggregations")
		keptCount := 0
		if kept != nil {
			keptCount = len(kept.a)
		}
		if !aggregations.isArray() || len(aggregations.a) != keptCount {
			return nil
		}
		if kept != nil {
			for _, clause := range kept.a {
				if diagnostics := clause.get("diagnostics"); diagnostics.isArray() && len(diagnostics.a) > 0 {
					return nil
				}
			}
		}
	}
	query := jsObj()
	for _, key := range linkPatchKeys {
		if raw.get(key) != nil && normalized.get(key) != nil {
			query.set(key, normalized.get(key))
		}
	}
	return jsObj().set("id", jsStr(id)).set("owns", jsStrings(jsUniqueStrings(facets))).set("query", query)
}
