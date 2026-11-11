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
	key, sql string
	args     []any
	fields   map[string]ValueSQL
	disabled bool
}

type sqliteTextDistinctMetric struct {
	input      *sqliteTextDistinctInput
	field      string
	groups     []string
	expression string
}

func (c *sqliteReductionCache) addTextDistinct(batch metricBatchPlan, q metricRequest, s Schema, o PlanOptions) {
	specs := map[string]AggSpec{}
	for _, spec := range q.Metrics {
		specs[spec.ID] = spec
	}
	groups := map[string][]metricSQLPlan{}
	nodes := map[string]*exprNode{}
	eligible := func(name string) bool {
		f, ok := s.Fields[name]
		return ok && (f.Kind == FieldText || f.Kind == FieldEnum) && !f.typedValue && !strings.HasPrefix(name, "@computed/")
	}
	for _, p := range batch.Metrics {
		spec := specs[p.ID]
		if p.reduction == nil || p.Scope != "allMatching" || spec.ExpressionY != "" || spec.Distribution != nil || spec.MinCount.Measure() != "" {
			continue
		}
		n, err := parseExpression(metricExpression(spec))
		if err != nil || !strings.EqualFold(n.op, "count_distinct") || len(n.args) != 1 || n.args[0].op != "field" || !eligible(n.args[0].text) {
			continue
		}
		valid := true
		for _, name := range spec.GroupBy {
			valid = valid && eligible(name)
		}
		// Computed filters require the full compiler's transitive definition plan.
		for _, terms := range [][]WhereTerm{q.Where, spec.Where} {
			for _, term := range terms {
				for _, pred := range term.Predicates() {
					valid = valid && !strings.HasPrefix(pred.Field, "@computed/")
				}
			}
		}
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
		where := append(append([]WhereTerm{}, q.Where...), specs[members[0].ID].Where...)
		filter, _, err := compileSQLiteWhere(where, s, sqliteOptions{Now: o.Now}, o.relations)
		if err != nil {
			continue
		}
		input := &sqliteTextDistinctInput{key: "text-input\x00" + key, fields: map[string]ValueSQL{}, args: append(append([]any{}, o.SourceArgs...), filter.Args...)}
		raw, checked := []string{}, []string{}
		for i, name := range names {
			alias := fmt.Sprintf("t%d", i)
			f := s.Fields[name]
			// Unary + removes inherited affinity: CTAS must preserve invalid storage
			// classes for the ordinary typed diagnostics instead of coercing them.
			raw = append(raw, "+("+f.Expr+") AS "+alias)
			inherited := "NULL"
			if f.ValueErrorExpr != "" {
				inherited = alias + "_inherited"
				raw = append(raw, f.ValueErrorExpr+" AS "+inherited)
			}
			errorAlias := alias + "_error"
			checked = append(checked, alias, "COALESCE("+inherited+",qt_v2_field_error("+alias+",'text')) AS "+errorAlias)
			input.fields[name] = ValueSQL{Value: "CASE WHEN " + errorAlias + " IS NULL THEN " + alias + " END COLLATE BINARY", Error: errorAlias, Type: "text"}
		}
		pred := ""
		if filter.SQL != "" {
			pred = " WHERE " + sqliteNumberParameters(filter.SQL, len(o.SourceArgs))
		}
		rawSQL := "SELECT " + strings.Join(raw, ",") + " FROM (" + o.SourceSQL + ") AS r" + pred
		rawName := "qt_text_distinct_input"
		for strings.Contains(strings.ToLower(rawSQL), rawName) {
			rawName += "_"
		}
		input.sql = "WITH " + rawName + " AS MATERIALIZED (" + rawSQL + ") SELECT " + strings.Join(checked, ",") + " FROM " + rawName
		for _, p := range members {
			c.textDistinct[sqliteReductionKey(p)] = sqliteTextDistinctMetric{input: input, field: nodes[p.ID].args[0].text, groups: specs[p.ID].GroupBy, expression: expressionKey(nodes[p.ID])}
		}
	}
}

func (c *sqliteReductionCache) textDistinctPlan(ctx context.Context, tx *sql.Tx, p metricSQLPlan, m sqliteTextDistinctMetric) (metricSQLPlan, error) {
	input := m.input
	table, ok := c.tables[input.key]
	if !ok {
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
	return sqliteReplaceStage(p, p.SQLiteReductionStage, statement)
}
