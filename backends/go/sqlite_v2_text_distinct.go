package querytable

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
)

// Text distinct metrics with different grouping lists can share their filtered,
// validated inputs. Each consumer still performs its own COUNT(DISTINCT): label
// memberships overlap, so a coarser count cannot be obtained by summing groups.
// This cache belongs to one execution/transaction, like the reduction cache.
// Keep error sidecars per field so an invalid grouping key affects only the
// metrics that consume it. Statement failures disable sharing and retry the
// ordinary independently compiled plans inside their metric savepoints.
type sqliteTextDistinctInput struct {
	key, sql    string
	nativeProof string
	args        []any
	fields      map[string]ValueSQL
	disabled    bool
}

type sqliteTextDistinctMetric struct {
	input      *sqliteTextDistinctInput
	field      string
	groups     []string
	expression string
}

// Homogeneous text-distinct grouping sets use SQLite's shared input instead of
// speculative Go hash sets. Large distinct populations can exceed the streamed
// reducer's retained-state bound and otherwise pay for a discarded source scan.
func sqliteTextDistinctPreferSQL(q QueryRequestV3, s Schema) bool {
	if len(q.Metrics) < 2 || !sqliteTextDistinctFilters(q.Result.Where) {
		return false
	}
	groups := map[string]bool{}
	var expression, predicates string
	for i, spec := range q.Metrics {
		n, ok := sqliteTextDistinctExpression(spec, s)
		if !ok {
			return false
		}
		where, _ := json.Marshal(spec.Where)
		key := expressionKey(n)
		if i == 0 {
			expression, predicates = key, string(where)
		}
		if key != expression || string(where) != predicates {
			return false
		}
		by, _ := json.Marshal(spec.GroupBy)
		groups[string(by)] = true
	}
	return len(groups) > 1
}

func sqliteTextDistinctFilters(where []WhereTerm) bool {
	for _, term := range where {
		for _, predicate := range term.Predicates() {
			if strings.HasPrefix(predicate.Field, "@computed/") {
				return false
			}
		}
	}
	return true
}

func sqliteTextDistinctExpression(spec AggSpec, s Schema) (*exprNode, bool) {
	if spec.Scope != "" && spec.Scope != "allMatching" || spec.ExpressionY != "" || spec.Distribution != nil || spec.DateGrouping != nil || spec.MinCount.Measure() != "" || !sqliteTextDistinctFilters(spec.Where) {
		return nil, false
	}
	n, err := parseExpression(metricExpression(spec))
	if err != nil || !strings.EqualFold(n.op, "count_distinct") || len(n.args) != 1 || n.args[0].op != "field" {
		return nil, false
	}
	eligible := func(name string) bool {
		f, ok := s.Fields[name]
		return ok && (f.Kind == FieldText || f.Kind == FieldEnum) && !f.typedValue && !strings.HasPrefix(name, "@computed/")
	}
	if !eligible(n.args[0].text) {
		return nil, false
	}
	for _, name := range spec.GroupBy {
		if !eligible(name) {
			return nil, false
		}
	}
	return n, true
}

func (c *sqliteReductionCache) addTextDistinct(ctx context.Context, batch metricBatchPlan, q metricRequest, s Schema, o PlanOptions) {
	specs := map[string]AggSpec{}
	for _, spec := range q.Metrics {
		specs[spec.ID] = spec
	}
	groups := map[string][]metricSQLPlan{}
	nodes := map[string]*exprNode{}
	if !sqliteTextDistinctFilters(q.Where) {
		return
	}
	for _, p := range batch.Metrics {
		spec := specs[p.ID]
		// Preserve existing fusion when one grouped reduction supplies several
		// different aggregate leaves (including non-distinct siblings). Sharing
		// only this member's input would otherwise repeat the fused grouping.
		if f := c.fusions[sqliteFusionKey(p)]; f != nil && len(f.reductions) > 1 {
			continue
		}
		if f := c.cross[sqliteReductionKey(p)]; f != nil {
			leaves := 0
			for _, identity := range f.plan.reduction.keys {
				if strings.HasPrefix(identity, "value\x00") {
					leaves++
				}
			}
			if leaves > 1 {
				continue
			}
		}
		if p.reduction == nil || p.Scope != "allMatching" {
			continue
		}
		n, valid := sqliteTextDistinctExpression(spec, s)
		if !valid {
			continue
		}
		key, err := json.Marshal(struct {
			Scope string
			Where []WhereTerm
		}{p.Scope, spec.Where})
		if err != nil {
			continue
		}
		groups[string(key)] = append(groups[string(key)], p)
		nodes[p.ID] = n
	}
	for key, members := range groups {
		// A singleton keeps the existing compact/single-input planner. Sharing is
		// useful even for equal groupings if distinct fields differ.
		reductions := map[string]bool{}
		for _, p := range members {
			reductions[sqliteReductionKey(p)] = true
		}
		if len(reductions) < 2 {
			continue
		}
		names := []string{}
		for _, p := range members {
			names = append(names, nodes[p.ID].args[0].text)
			names = append(names, specs[p.ID].GroupBy...)
		}
		sort.Strings(names)
		names = slices.Compact(names)
		if len(names) > 128 {
			continue
		}
		// Use the ordinary compiler's source projection and separate filter
		// stages. Moving predicates into the binding SELECT would change window
		// values (and bindings over aggregate sources) before grouping them.
		builder, err := newPlanDialect(ctx, s, o, true)
		if err != nil {
			continue
		}
		if err = builder.filter(q.Where); err != nil {
			continue
		}
		if err = builder.filter(specs[members[0].ID].Where); err != nil {
			continue
		}
		input := &sqliteTextDistinctInput{key: "text-input\x00" + key, fields: map[string]ValueSQL{}}
		raw, checked := []string{}, []string{}
		for i, name := range names {
			alias := fmt.Sprintf("t%d", i)
			v := builder.raw[name]
			// Unary + removes inherited affinity: CTAS must preserve invalid storage
			// classes for the ordinary typed diagnostics instead of coercing them.
			raw = append(raw, "+("+v.Value+") AS "+alias)
			inherited := "NULL"
			if v.Error != "NULL" {
				inherited = alias + "_inherited"
				raw = append(raw, v.Error+" AS "+inherited)
			}
			errorAlias := alias + "_error"
			checked = append(checked, alias, "COALESCE("+inherited+",qt_v2_field_error("+alias+",'text')) AS "+errorAlias)
			input.fields[name] = ValueSQL{Value: "CASE WHEN " + errorAlias + " IS NULL THEN " + alias + " END COLLATE BINARY", Error: errorAlias, Type: "text"}
		}
		rawPlan := builder.finish("SELECT "+strings.Join(raw, ",")+" FROM "+builder.rel, "allMatching", nil)
		// If every member already has a compact native reduction, prove the
		// shared raw projection before adding population-sized materialization.
		// Successful stored-read proof preserves those smaller existing plans.
		native := true
		for _, p := range members {
			f := c.cross[sqliteReductionKey(p)]
			native = native && f != nil && f.integer != nil
		}
		if native {
			input.nativeProof = rawPlan.SQL
		}
		input.args = rawPlan.Args
		rawName := "qt_text_distinct_input"
		for strings.Contains(strings.ToLower(rawPlan.SQL), rawName) {
			rawName += "_"
		}
		input.sql = "WITH " + rawName + " AS MATERIALIZED (" + rawPlan.SQL + ") SELECT " + strings.Join(checked, ",") + " FROM " + rawName
		for _, p := range members {
			c.textDistinct[sqliteReductionKey(p)] = sqliteTextDistinctMetric{input: input, field: nodes[p.ID].args[0].text, groups: specs[p.ID].GroupBy, expression: expressionKey(nodes[p.ID])}
		}
	}
}

func (c *sqliteReductionCache) textDistinctPlan(ctx context.Context, tx *sql.Tx, p metricSQLPlan, m sqliteTextDistinctMetric) (metricSQLPlan, error) {
	input := m.input
	table, ok := c.tables[input.key]
	if !ok {
		if input.nativeProof != "" {
			direct, err := sqliteStoredProjection(ctx, tx, input.nativeProof, input.args)
			if err != nil {
				return p, err
			}
			input.nativeProof = "" // A declined proof need not be repeated.
			if direct {
				input.disabled = true
				return c.plan(ctx, tx, p)
			}
		}
		table = fmt.Sprintf("_qt_reduction_%d", sqliteReductionSequence.Add(1))
		c.tables[input.key] = table // Register ownership before interruptible DDL.
		if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE "+table+" AS "+input.sql, input.args...); err != nil {
			if ctx.Err() != nil {
				return p, ctx.Err()
			}
			input.disabled = true
			return c.plan(ctx, tx, p)
		}
	}
	columns, by := []string{}, []string{}
	values := map[string]string{"count": "COUNT(*)"}
	field := input.fields[m.field]
	values["value\x00"+m.expression] = "CAST(COUNT(DISTINCT " + field.Value + ") AS REAL)"
	values["error\x00"+m.expression] = "MIN(" + field.Error + ")"
	for i, name := range m.groups {
		v := input.fields[name]
		alias := fmt.Sprintf("group%d", i)
		values[alias], values[alias+"_error"] = v.Value, v.Error
		by = append(by, v.Value, v.Error)
	}
	for _, col := range p.SQLiteReductionColumns {
		value, ok := values[p.reduction.keys[col.Name]]
		if !ok {
			return p, fmt.Errorf("invalid text distinct compiler reduction envelope")
		}
		columns = append(columns, value+" AS "+col.Name)
	}
	statement := "SELECT " + strings.Join(columns, ",") + " FROM " + table
	if len(by) > 0 {
		statement += " GROUP BY " + strings.Join(by, ",")
	}
	prepared, err := sqliteReplaceStage(p, p.SQLiteReductionStage, statement)
	if err != nil {
		return p, err
	}
	key := sqliteReductionKey(p)
	if c.shared[key] {
		// Sort, top-N and minCount variants share this bounded reduction too,
		// rather than repeating GROUP BY/COUNT(DISTINCT) over the shared input.
		return c.reuseStage(ctx, tx, prepared, p.SQLiteReductionStage, "text-reduction\x00"+key)
	}
	return prepared, nil
}
