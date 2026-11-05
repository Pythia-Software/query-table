package querytable

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const GroupIdentityField = "__qt_group_id__"

type GroupingDefinition struct {
	// Keys names the source field of each key, in order. Each is also the
	// key's result column.
	Keys []string `json:"keys"`
	// KeyIntervals holds the calendar interval of each key that groups a
	// datetime field by interval, keyed by field name. On the wire such a key
	// is the object {"field", "interval", "timeZone"} instead of a string.
	KeyIntervals   map[string]GroupKeyInterval `json:"-"`
	Summaries      []SummaryColumn             `json:"summaries"`
	Representative *RepresentativeRow          `json:"representative"`
}

// GroupKeyInterval buckets a datetime grouping key by calendar interval: one
// group per hour, day, week (from Monday), month or year in TimeZone (an IANA
// name; empty means UTC), keyed by the interval's start instant. Intervals
// follow the metric calendar, including daylight-saving changes.
type GroupKeyInterval struct {
	Interval string `json:"interval"`
	TimeZone string `json:"timeZone,omitempty"`
}

type groupingDefinitionJSON struct {
	Keys           []json.RawMessage  `json:"keys"`
	Summaries      []SummaryColumn    `json:"summaries"`
	Representative *RepresentativeRow `json:"representative"`
}

// MarshalJSON writes a key with an interval as {"field","interval","timeZone"}.
func (g GroupingDefinition) MarshalJSON() ([]byte, error) {
	// keys and summaries are required arrays on the wire, even when empty.
	out := groupingDefinitionJSON{Summaries: g.Summaries, Representative: g.Representative, Keys: []json.RawMessage{}}
	if out.Summaries == nil {
		out.Summaries = []SummaryColumn{}
	}
	for _, key := range g.Keys {
		var value any = key
		if interval, ok := g.KeyIntervals[key]; ok {
			value = CalendarGroupKey{key, interval.Interval, interval.TimeZone}
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		out.Keys = append(out.Keys, raw)
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads keys that are field names or calendar key objects.
// Calendar key objects accept only field, interval and timeZone.
func (g *GroupingDefinition) UnmarshalJSON(data []byte) error {
	var in groupingDefinitionJSON
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return err
	}
	*g = GroupingDefinition{Summaries: in.Summaries, Representative: in.Representative}
	for _, raw := range in.Keys {
		var name string
		if err := json.Unmarshal(raw, &name); err == nil {
			g.Keys = append(g.Keys, name)
			continue
		}
		var key CalendarGroupKey
		keyDecoder := json.NewDecoder(bytes.NewReader(raw))
		keyDecoder.DisallowUnknownFields()
		if err := keyDecoder.Decode(&key); err != nil {
			return diagnostic(ErrorCodeGrouping, "a group key is a field name or {field, interval, timeZone}")
		}
		if g.KeyIntervals == nil {
			g.KeyIntervals = map[string]GroupKeyInterval{}
		}
		if _, duplicate := g.KeyIntervals[key.Field]; duplicate {
			return diagnostic(ErrorCodeGrouping, "invalid or duplicate group key")
		}
		g.Keys = append(g.Keys, key.Field)
		g.KeyIntervals[key.Field] = GroupKeyInterval{key.Interval, key.TimeZone}
	}
	if in.Keys != nil && g.Keys == nil {
		g.Keys = []string{}
	}
	return nil
}

// groupKeyLocation validates a calendar group key over a field of the given
// value type and loads its zone.
func groupKeyLocation(typ, field string, interval GroupKeyInterval) (*time.Location, error) {
	if !containsString([]string{"hour", "day", "week", "month", "year"}, interval.Interval) {
		return nil, diagnostic(ErrorCodeGrouping, "a group key interval is hour, day, week, month or year; hour-of-day and day-of-week are metric intervals")
	}
	if typ != "datetime" {
		return nil, diagnostic(ErrorCodeGrouping, "a calendar group key needs a datetime field")
	}
	return calendarLocation(MetricDateGrouping{Field: field, Interval: interval.Interval, TimeZone: interval.TimeZone, Range: "query"})
}

// Validate classifies malformed wire stages and metrics as request diagnostics,
// including for hosts that construct requests directly instead of decoding JSON.
func (q QueryRequestV3) Validate() error {
	if q.Version != 3 {
		return diagnostic(ErrorCodeVersion, "a valid version 3 query is required")
	}
	// Host state is opaque, but always a JSON object (see the wire schema).
	if host := bytes.TrimSpace(q.HostState); len(host) > 0 && host[0] != '{' {
		return diagnostic(ErrorCodeInvalidQuery, "hostState must be a JSON object")
	}
	for _, stage := range []struct {
		name  string
		query WireQuery
	}{{"source", q.Source}, {"result", q.Result}} {
		if err := stage.query.Validate(); err != nil {
			return withContext(err, ErrorCodeInvalidQuery, stage.name+": ")
		}
	}
	if err := validateMetricSpecs(q.Metrics); err != nil {
		return withContext(err, ErrorCodeInvalidMetric, "metrics: ")
	}
	if q.Distinct != nil {
		if q.Rows || len(q.Metrics) > 0 || q.Grouping != nil {
			return diagnostic(ErrorCodeInvalidQuery, "distinct requests take no rows, metrics or grouping")
		}
		if q.Distinct.Field == "" || q.Distinct.Limit < 1 || q.Distinct.Limit > 500 || utf16Length(q.Distinct.Search) > 2000 {
			return diagnostic(ErrorCodeInvalidQuery, "distinct needs a field, a limit of 1–500 and a search of at most 2000 characters")
		}
	}
	return nil
}

// QueryDatasetV3 works with SQLite and PostgreSQL. SQLite hosts register the
// existing SQLiteFunctions/SQLiteV2Functions. PostgreSQL uses its native exact
// reducers. No database driver, arbitrary request SQL or retained snapshot is
// supplied by this package.
type QueryDatasetV3 struct {
	Schema             Schema
	SourceSQL          string
	SourceArgs         []any
	Scope, Dataset     string
	Dialect            string // sqlite or postgres
	ComputedGroupable  map[string]bool
	ComputedFilterable map[string]bool
	// Zero defaults to 10000 rows, 2000 groups and 250000 matching source rows.
	// Explicit MaxGroups may be 1..100000. MaxPopulation and MaxStagingBytes
	// bound staged (grouped) execution and calendar metric scratch only:
	// ungrouped rows, totals, metrics and distinct values read SourceSQL directly.
	MaxRows, MaxGroups, MaxPopulation int
	// UTF-8 value/error payload of the narrow source, checked before its copy.
	// Database storage overhead and query scratch space remain host-managed.
	MaxStagingBytes    int64
	MaxSamplesPerGroup int
	// PredicateRelations optionally supplies host relations for base-field
	// source and row filter predicates (SQLite only). Group filters over
	// grouped results never use them. Nil compiles every predicate normally.
	// See SQLitePredicateRelations.
	PredicateRelations SQLitePredicateRelations
	// stageUngrouped sends ungrouped requests through the staged executor;
	// see TestOnlyStageUngrouped.
	stageUngrouped bool
}

func (d QueryDatasetV3) limits() (int, int, int, int64, error) {
	if strings.TrimSpace(d.SourceSQL) == "" || d.Schema.IDField == "" || len(d.Schema.Fields) == 0 {
		return 0, 0, 0, 0, diagnostic(ErrorCodeDataset, "a source, schema and identity field are required")
	}
	identity, ok := d.Schema.Fields[d.Schema.IDField]
	if !ok || identity.Synthetic || strings.TrimSpace(identity.Expr) == "" || (identity.Kind != FieldText && identity.Kind != FieldNumber && identity.Kind != FieldEnum) {
		return 0, 0, 0, 0, diagnostic(ErrorCodeDataset, "source identity needs a bound text or numeric field")
	}
	rows, groups, pop, bytes := d.MaxRows, d.MaxGroups, d.MaxPopulation, d.MaxStagingBytes
	if rows == 0 {
		rows = 10000
	}
	if groups == 0 {
		groups = 2000
	}
	if pop == 0 {
		pop = 250000
	}
	if bytes == 0 {
		bytes = 64 << 20
	}
	if rows < 1 || rows > 10000 || groups < 1 || groups > 100000 || pop < 1 || pop > 10000000 || bytes < 1 || bytes > 1<<30 {
		return 0, 0, 0, 0, diagnostic(ErrorCodeDataset, "invalid host execution budgets")
	}
	if d.Dialect != "sqlite" && d.Dialect != "postgres" {
		return 0, 0, 0, 0, diagnostic(ErrorCodeDataset, "choose sqlite or postgres")
	}
	return rows, groups, pop, bytes, nil
}
func (d QueryDatasetV3) Capabilities() QueryCapabilitiesV3 {
	rows, groups, pop, _, _ := d.limits()
	profile := ServerExpressionProfile
	if d.Dialect == "sqlite" {
		profile = SQLiteExpressionProfile
	}
	return QueryCapabilitiesV3{Version: 3, GroupedRows: true, CalendarGrouping: true, CalendarCycles: true, CalendarGroupKeys: true, ComputedSourceFilters: len(d.ComputedFilterable) > 0, Regex: false, RegexSourceFilters: d.Dialect == "sqlite", MetricFilters: true, MetricMinCount: true, MetricMinCountMeasures: true, MaxRows: rows, MaxGroups: groups, MaxPopulation: pop, Profile: profile}
}
func (d QueryDatasetV3) options(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions) (PlanOptions, error) {
	if err := ctx.Err(); err != nil {
		return o, err
	}
	if tx == nil {
		return o, fmt.Errorf("nil query transaction")
	}
	if q.Version != 3 {
		return o, diagnostic(ErrorCodeVersion, "a valid version 3 query is required")
	}
	if q.Profile != d.Capabilities().Profile {
		return o, diagnostic(ErrorCodeProfileMismatch, "requested query profile is unavailable")
	}
	if q.Now < -8640000000000000 || q.Now > 8640000000000000 {
		return o, diagnostic(ErrorCodeDatetimeValue, "invalid evaluation clock")
	}
	o.Now = time.UnixMilli(q.Now)
	o.SourceSQL = d.SourceSQL
	o.SourceArgs = append([]any{}, d.SourceArgs...)
	o.ComputedGroupable = d.ComputedGroupable
	o.ComputedFilterable = d.ComputedFilterable
	if d.PredicateRelations != nil && d.Dialect != "sqlite" {
		return o, diagnostic(ErrorCodeDataset, "predicate relations require the sqlite dialect")
	}
	o.relations = newSQLiteRelations(ctx, tx, d.PredicateRelations)
	if o.Resolver == nil {
		if d.Dialect == "sqlite" {
			o.Resolver = SQLiteComputedDefinitionResolver{Tx: tx, Scope: d.Scope, Dataset: d.Dataset}
		} else {
			o.Resolver = SQLComputedDefinitionResolver{Tx: tx, Scope: d.Scope, Dataset: d.Dataset}
		}
	}
	original := o.Resolver
	cache := map[string]ComputedColumn{}
	o.Resolver = DefinitionResolverFunc(func(ctx context.Context, id string) (ComputedColumn, error) {
		if c, ok := cache[id]; ok {
			return c, nil
		}
		c, e := original.ResolveComputed(ctx, id)
		if e == nil {
			cache[id] = c
		}
		return c, e
	})
	return o, nil // SourcePlan validates the revision/token/snapshot envelope once.
}

type SourceDependencyPlan struct {
	ComputedCapabilities map[string]ComputedFieldCapability
	ComputedPolicies     map[string][]string
	SQLPlan
	Fields       []string // source projection, including canonical computed keys
	BaseFields   []string // transitive base inputs for host staging
	ResultSchema Schema
	SummaryPlans map[string]SQLPlan
}

func expressionFields(source string) ([]string, error) {
	node, err := parseExpression(source)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var visit func(*exprNode)
	visit = func(n *exprNode) {
		if n.op == "field" {
			seen[n.text] = true
		}
		for _, child := range n.args {
			visit(child)
		}
	}
	visit(node)
	names := []string{}
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
func summarySpec(s SummaryColumn, keys []string) AggSpec {
	spec := AggSpec{ID: s.ID, Op: s.Op, Field: s.Field, GroupBy: keys}
	if s.Op == "formula" {
		spec.Op = "count"
		spec.Expression = s.Expression
	}
	return spec
}
func resultField(name, typ, expr string, groupable bool) FieldSpec {
	kind, _ := kindFromString(typ)
	return FieldSpec{Name: name, Kind: kind, Expr: expr, ServerFilter: true, Sortable: true, ExpressionNumeric: true, Groupable: &groupable}
}

// SourcePlan discovers keys, formulas, ROW projections, representative ordering,
// source predicates and canonical transitive inputs. Result/HAVING aliases are
// never mistaken for source fields. It performs no reads outside the resolver.
func (d QueryDatasetV3) SourcePlan(ctx context.Context, q QueryRequestV3, o PlanOptions) (SourceDependencyPlan, error) {
	var out SourceDependencyPlan
	if err := ctx.Err(); err != nil {
		return out, err
	}
	_, _, pop, _, err := d.limits()
	if err != nil {
		return out, err
	}
	if err = q.Validate(); err != nil {
		return out, err
	}
	sqlite := d.Dialect == "sqlite"
	if q.Version != 3 || q.Profile != d.Capabilities().Profile {
		return out, diagnostic(ErrorCodeVersion, "a valid negotiated v3 query is required")
	}
	if q.Now < -8640000000000000 || q.Now > 8640000000000000 {
		return out, diagnostic(ErrorCodeDatetimeValue, "invalid evaluation clock")
	}
	o.Now = time.UnixMilli(q.Now)
	o, err = requestOptionsDialect(ctx, sqlite, q.Profile, q.PlanToken, q.Snapshot, q.ExpectedRevisions, o)
	if err != nil {
		return out, err
	}
	o.SourceSQL = d.SourceSQL
	o.SourceArgs = d.SourceArgs
	o.ComputedGroupable = d.ComputedGroupable
	o.ComputedFilterable = d.ComputedFilterable
	fields := map[string]bool{d.Schema.IDField: true}
	if len(q.ExpectedRevisions) > 64 {
		return out, diagnostic(ErrorCodeDependencyLimit, "revision envelope exceeds budget")
	}
	for id, revision := range q.ExpectedRevisions {
		if !computedID.MatchString(id) || revision == "" || len(revision) > 256 || o.Resolver == nil {
			return out, diagnostic(ErrorCodeDefinitionChanged, "invalid computed revision envelope")
		}
		_, e := compileRowExpressionDialect(ctx, "[@computed/"+id+"]", d.Schema, o, sqlite)
		if e != nil {
			return out, e
		}
	}
	out.SummaryPlans = map[string]SQLPlan{}
	result := d.Schema
	source := q.Source
	if q.Grouping != nil {
		g := q.Grouping
		if len(g.Keys) == 0 || len(g.Keys) > 20 || len(g.Summaries) > 64 {
			return out, diagnostic(ErrorCodeGrouping, "invalid grouping definition")
		}
		count := AggSpec{ID: "__qt_count__", Op: "count", GroupBy: g.Keys}
		plan, e := compileMetricDialect(ctx, metricRequest{Version: 2}, count, d.Schema, o, sqlite)
		if e != nil {
			return out, e
		}
		result = Schema{Name: d.Schema.Name + ":groups", IDField: GroupIdentityField, Fields: map[string]FieldSpec{GroupIdentityField: resultField(GroupIdentityField, "text", "r.identity", false)}}
		seen := map[string]bool{}
		for field := range g.KeyIntervals {
			if !containsString(g.Keys, field) {
				return out, diagnostic(ErrorCodeGrouping, "a calendar interval names an unknown group key")
			}
		}
		for i, key := range g.Keys {
			if seen[key] || key == GroupIdentityField {
				return out, diagnostic(ErrorCodeGrouping, "invalid or duplicate group key")
			}
			if interval, ok := g.KeyIntervals[key]; ok {
				if _, e := groupKeyLocation(plan.Columns[i].Type, key, interval); e != nil {
					return out, e
				}
			}
			seen[key] = true
			fields[key] = true
			result.Fields[key] = resultField(key, plan.Columns[i].Type, fmt.Sprintf("r.group%d", i), true)
		}
		for _, s := range g.Summaries {
			if s.ID == "" || len(s.ID) > 256 || seen[s.ID] || s.ID == GroupIdentityField || strings.HasPrefix(s.ID, "@computed/") || s.ID == "__proto__" || s.ID == "prototype" || s.ID == "constructor" {
				return out, diagnostic(ErrorCodeGrouping, "invalid or duplicate summary ID")
			}
			if _, ok := d.Schema.Fields[s.ID]; ok {
				return out, diagnostic(ErrorCodeGrouping, "summary ID collides with source field")
			}
			seen[s.ID] = true
			var p SQLPlan
			if s.Op == "row" {
				if g.Representative == nil {
					return out, diagnostic(ErrorCodeRepresentative, "ROW needs representative ordering")
				}
				p, err = compileRowExpressionDialect(ctx, "["+strings.ReplaceAll(s.Field, "]", "]]")+"]", d.Schema, o, sqlite)
				fields[s.Field] = true
			} else {
				p, err = compileMetricDialect(ctx, metricRequest{Version: 2}, summarySpec(s, g.Keys), d.Schema, o, sqlite)
				if err == nil {
					names, e := expressionFields(metricExpression(summarySpec(s, g.Keys)))
					if e != nil {
						return out, e
					}
					for _, n := range names {
						fields[n] = true
					}
				}
			}
			if err != nil {
				return out, err
			}
			out.SummaryPlans[s.ID] = p
			typ := p.Columns[len(p.Columns)-1].Type
			groupable := typ == "text" || typ == "bool"
			if s.Op == "row" || s.Op == "min" || s.Op == "max" {
				if original, ok := d.Schema.Fields[s.Field]; ok {
					groupable = fieldGroupable(original)
				}
			}
			result.Fields[s.ID] = resultField(s.ID, typ, "", groupable)
			if (s.Op == "row" || s.Op == "min" || s.Op == "max") && d.Schema.Fields[s.Field].Kind == FieldEnum {
				field := result.Fields[s.ID]
				field.Kind = FieldEnum
				result.Fields[s.ID] = field
			}
		}
		if g.Representative != nil {
			if len(g.Representative.OrderBy) == 0 || len(g.Representative.OrderBy) > 8 {
				return out, diagnostic(ErrorCodeRepresentative, "choose 1–8 representative sort fields")
			}
			for _, term := range g.Representative.OrderBy {
				if term.Extract != nil {
					return out, diagnostic(ErrorCodeUnsupportedRegex, "regex representative sorting is unavailable")
				}
				fields[term.Field] = true
				if field, ok := d.Schema.Fields[term.Field]; ok && field.SQLiteSortField != "" {
					fields[field.SQLiteSortField] = true
				}
			}
		}
		source.Select = nil
		source.OrderBy = nil
		source.Offset = 0
		source.Limit = pop + 1
	} else {
		source = q.Result
		// The result stage reapplies ordinary-row predicates after the narrow
		// source has been staged. Native WHERE inputs must remain available even
		// when they are outside the visible SELECT projection.
		for _, term := range source.Where {
			for _, predicate := range term.Predicates() {
				fields[predicate.Field] = true
			}
		}
		if !q.Rows {
			source.Select = nil
		}
		for _, name := range source.Select {
			fields[name] = true
		}
		for _, term := range append(append(append([]OrderBy{}, source.OrderBy...), d.Schema.DefaultSort...), d.Schema.TiebreakSort...) {
			fields[term.Field] = true
			if field, ok := d.Schema.Fields[term.Field]; ok && field.SQLiteSortField != "" {
				fields[field.SQLiteSortField] = true
			}
		}
		orderPlan, e := newPlanDialect(ctx, d.Schema, o, sqlite)
		if e != nil {
			return out, e
		}
		if _, e = orderPlan.order(source.OrderBy); e != nil {
			return out, e
		}
		for _, spec := range q.Metrics {
			names, e := expressionFields(metricExpression(spec))
			if e != nil {
				return out, e
			}
			for _, n := range append(names, spec.GroupBy...) {
				fields[n] = true
			}
			if name := spec.MinCount.field(); name != "" {
				fields[name] = true
			}
			for _, term := range spec.Where {
				for _, predicate := range term.Predicates() {
					fields[predicate.Field] = true
				}
			}
			if spec.ExpressionY != "" {
				names, e = expressionFields(spec.ExpressionY)
				if e != nil {
					return out, e
				}
				for _, n := range names {
					fields[n] = true
				}
			}
			if spec.Distribution != nil {
				names, e = expressionFields(spec.Distribution.Input)
				if e != nil {
					return out, e
				}
				for _, n := range names {
					fields[n] = true
				}
			}
		}
		source.Limit = pop + 1
		source.Offset = 0
	}
	if len(fields) > 200 {
		return out, diagnostic(ErrorCodeDependencyLimit, "source projection exceeds field budget")
	}
	for name := range fields {
		source.Select = append(source.Select, name)
	}
	sort.Strings(source.Select)
	source.Select = uniqueStrings(source.Select)
	// The complete source has no page semantics. Sorting it (including host
	// defaults) adds work without affecting reducers or representative ordering.
	source.OrderBy = nil
	sourceSchema := d.Schema
	sourceSchema.DefaultSort = nil
	sourceSchema.TiebreakSort = nil
	plan, err := compileQuerySource(ctx, source, sourceSchema, o, sqlite)
	if err != nil {
		return out, err
	}
	out.SQLPlan = plan
	out.ComputedPolicies = map[string][]string{}
	out.ComputedCapabilities = map[string]ComputedFieldCapability{}
	for _, column := range plan.Columns {
		if strings.HasPrefix(column.Field, "@computed/") {
			definition, e := compileRowExpressionDialect(ctx, "["+column.Field+"]", d.Schema, o, sqlite)
			if e != nil {
				return out, e
			}
			out.ComputedPolicies[column.Field] = computedInputPolicy(definition, d.Schema)
			capability := (sqliteV2Dataset{Schema: d.Schema, ComputedGroupable: d.ComputedGroupable}).capabilityForPlan(column.Field, definition)
			capability.Filter = d.ComputedFilterable[strings.TrimPrefix(column.Field, "@computed/")]
			out.ComputedCapabilities[column.Field] = capability
		}
	}
	for id, revision := range q.ExpectedRevisions {
		out.ResolvedRevisions[id] = revision
	}
	out.Fields = append([]string{}, source.Select...)
	out.ResultSchema = result
	for _, name := range plan.Dependencies {
		if !strings.HasPrefix(name, "@computed/") {
			out.BaseFields = append(out.BaseFields, name)
		}
	}
	// Native predicates are emitted directly from their schema bindings and
	// do not appear in the expression compiler's dependency list. Hosts staging
	// map-backed sources still need their base inputs before source WHERE runs.
	for _, term := range source.Where {
		for _, predicate := range term.Predicates() {
			if _, base := d.Schema.Fields[predicate.Field]; base {
				out.BaseFields = append(out.BaseFields, predicate.Field)
			}
		}
	}
	sort.Strings(out.BaseFields)
	out.BaseFields = uniqueStrings(out.BaseFields)
	return out, nil
}

// A complete population needs typed projections and source predicates, but no
// ordered row window. The normal row compiler always adds stable ID sorting.
func compileQuerySource(ctx context.Context, q WireQuery, s Schema, o PlanOptions, sqlite bool) (SQLPlan, error) {
	if err := q.Validate(); err != nil {
		return SQLPlan{}, err
	}
	b, err := newPlanDialect(ctx, s, o, sqlite)
	if err != nil {
		return SQLPlan{}, err
	}
	if err = b.filter(q.Where); err != nil {
		return SQLPlan{}, err
	}
	columns := []OutputColumn{}
	selects := []string{}
	for i, name := range q.Select {
		value, err := b.sourceValue(name)
		if field, ok := s.Fields[name]; ok && field.Kind == FieldTextArray {
			value = b.fields[name]
			value.Type, err = "textarray", nil
		}
		if err != nil {
			return SQLPlan{}, err
		}
		alias := fmt.Sprintf("column%d", i)
		columns = append(columns, OutputColumn{name, alias, alias + "_error", value.Type})
		selects = append(selects, value.Value+" AS "+alias, value.Error+" AS "+alias+"_error")
	}
	sql := "SELECT " + strings.Join(selects, ",") + " FROM " + b.rel + " LIMIT " + b.param(q.Limit, "bigint")
	return b.finish(sql, "allMatching", columns), nil
}
func uniqueStrings(names []string) []string {
	out := []string{}
	for _, n := range names {
		if len(out) == 0 || out[len(out)-1] != n {
			out = append(out, n)
		}
	}
	return out
}
func computedInputPolicy(plan SQLPlan, s Schema) []string {
	var allowed map[string]bool
	for _, name := range plan.Dependencies {
		field, ok := s.Fields[name]
		if !ok || field.AggregateOps == nil {
			continue
		}
		current := map[string]bool{}
		for _, op := range field.AggregateOps {
			current[op] = true
		}
		if allowed == nil {
			allowed = current
		} else {
			for op := range allowed {
				if !current[op] {
					delete(allowed, op)
				}
			}
		}
	}
	if allowed == nil {
		return nil
	}
	result := []string{}
	for op := range allowed {
		result = append(result, op)
	}
	sort.Strings(result)
	return result
}
func (d QueryDatasetV3) sampleLimit() (int, error) {
	limit := d.MaxSamplesPerGroup
	if limit == 0 {
		limit = SQLiteMaxMedianSamples
	}
	if limit < 1 || limit > 1000000 {
		return 0, diagnostic(ErrorCodeDataset, "invalid exact sample budget")
	}
	return limit, nil
}
func sampledExpression(source string) bool {
	node, err := parseExpression(source)
	if err != nil {
		return false
	}
	var visit func(*exprNode) bool
	visit = func(n *exprNode) bool {
		if strings.EqualFold(n.op, "median") {
			return true
		}
		for _, child := range n.args {
			if visit(child) {
				return true
			}
		}
		return false
	}
	return visit(node)
}
