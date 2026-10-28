package querytable

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

type sqliteIntegerPlan struct {
	SQL, NonnegativeSQL, Input string
	Args                       []any
}

// V3 also proves the complete narrow source's byte size and identity storage.
// These private columns never become public summary outputs.
type sqliteIntegerSourceProof struct {
	columns                  []OutputColumn
	maxPopulation, maxGroups int
}

// Speculative reductions for plain scalar metrics over integer storage. Opaque
// host bindings retain one materialized raw projection. Checked integer SUM
// proves nonnegative populations directly; signed inputs also check their exact
// absolute total. Other domains retain the ordinary exact decimal reducer.
// No schema declaration or sampled row is treated as proof about the population.
func sqliteIntegerReduction(ctx context.Context, q MetricQuery, specs []AggSpec, s Schema, o PlanOptions, combined SQLPlan, sourceProof ...sqliteIntegerSourceProof) *sqliteIntegerPlan {
	if len(specs) < 2 || combined.Scope != "allMatching" {
		return nil
	}
	fields := map[string]bool{}
	nodes := map[string]*exprNode{}
	expressions := []string{}
	for _, spec := range specs {
		expressions = append(expressions, MetricExpression(spec))
		// A measured minCount is one more reduction of the combined plan.
		if measure := spec.MinCount.Measure(); measure != "" {
			expressions = append(expressions, measure)
		}
	}
	for _, expression := range expressions {
		n, err := parseExpression(expression)
		if err != nil || !aggOpKnown(strings.ToLower(n.op)) || len(n.args) > 1 {
			return nil
		}
		op := strings.ToLower(n.op)
		if op != "count" && op != "sum" && op != "avg" && op != "min" && op != "max" && op != "count_distinct" {
			return nil
		}
		if len(n.args) == 0 {
			if op != "count" {
				return nil
			}
		} else {
			if n.args[0].op != "field" {
				return nil
			}
			name := n.args[0].text
			f, ok := s.Fields[name]
			if !ok || f.Kind != FieldNumber || !f.ExpressionNumeric || f.ValueErrorExpr != "" {
				return nil
			}
			fields[name] = true
		}
		nodes[expressionKey(n)] = n
	}
	for _, name := range specs[0].GroupBy {
		f, ok := s.Fields[name]
		if !ok || (f.Kind != FieldText && f.Kind != FieldEnum && f.Kind != FieldBool) || f.ValueErrorExpr != "" {
			return nil
		}
		fields[name] = true
	}
	if len(sourceProof) > 0 {
		for _, column := range sourceProof[0].columns {
			if !fields[column.Field] {
				f, ok := s.Fields[column.Field]
				// The only otherwise unused projection is a text identity. A
				// numeric identity, computed input or inherited error falls back.
				if !ok || (f.Kind != FieldText && f.Kind != FieldEnum) || f.ValueErrorExpr != "" {
					return nil
				}
				fields[column.Field] = true
			}
		}
	}
	names := []string{}
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	aliases := map[string]string{}
	projections := []string{}
	for i, name := range names {
		alias := fmt.Sprintf("i%d", i)
		aliases[name] = alias
		projections = append(projections, s.Fields[name].Expr+" AS "+alias)
	}
	if len(projections) == 0 {
		projections = []string{"1 AS qt_present"}
	}
	where := append(append([]WhereTerm{}, q.Where...), specs[0].Where...)
	filter, err := CompileSQLiteWhere(where, s, SQLiteOptions{Now: o.Now})
	if err != nil || ctx.Err() != nil {
		return nil
	}
	args := append(append([]any{}, o.SourceArgs...), filter.Args...)
	pred := ""
	if filter.SQL != "" {
		pred = " WHERE " + sqliteNumberParameters(filter.SQL, len(o.SourceArgs))
	}
	input := "SELECT " + strings.Join(projections, ",") + " FROM (" + o.SourceSQL + ") AS r" + pred
	if len(sourceProof) > 0 {
		input += fmt.Sprintf(" LIMIT %d", sourceProof[0].maxPopulation+1)
	}
	inputName := "qt_integer_input"
	for strings.Contains(strings.ToLower(input), inputName) {
		inputName += "_"
	}
	groupBy := []string{}
	columns := []string{}
	guards := []string{}
	for i, name := range specs[0].GroupBy {
		raw := aliases[name]
		typ := expressionType(s.Fields[name].Kind)
		columns = append(columns, fmt.Sprintf("%s AS group%d,NULL AS group%d_error", raw, i, i))
		groupBy = append(groupBy, raw+" COLLATE BINARY")
		guard := "qt_v2_field_error(" + raw + ",'" + typ + "')"
		// BINARY text groups contain one exact string (or NULL). Validate that
		// value once per group. Numeric equality can merge INTEGER and REAL
		// booleans, so bool keys still need a per-row storage check.
		if typ == "bool" {
			guard = "MAX(" + guard + ")"
		}
		guards = append(guards, guard+" IS NULL")
	}
	if len(sourceProof) > 0 {
		parts := []string{}
		for _, column := range sourceProof[0].columns {
			raw := aliases[column.Field]
			parts = append(parts, "COALESCE(length(CAST(CAST("+raw+" AS TEXT) AS BLOB)),0)")
			if !containsString(specs[0].GroupBy, column.Field) && (column.Type == "text" || column.Type == "enum") {
				guards = append(guards, "MIN(qt_v2_field_error("+raw+",'source_text')) IS NULL")
			}
		}
		// Window proofs cover every group before LIMIT bounds the staged
		// output. Budgets and invalid values in an omitted group must not be
		// hidden by that limit, or change ordinary diagnostic precedence.
		columns = append(columns, "SUM(COUNT(*)) OVER () AS qt_source_count", "SUM(COALESCE(SUM("+strings.Join(parts, "+")+"),0)) OVER () AS qt_source_bytes")
	}
	plan := &sqliteIntegerPlan{Input: input, Args: args}
	baseColumns, baseGuards := columns, guards
	for _, nonnegative := range []bool{false, true} {
		columns, guards := append([]string{}, baseColumns...), append([]string{}, baseGuards...)
		for _, col := range combined.SQLiteReductionColumns {
			identity := combined.reduction.keys[col.Name]
			if identity == "count" {
				columns = append(columns, "COUNT(*) AS "+col.Name)
				continue
			}
			if strings.HasPrefix(identity, "group") {
				continue
			}
			kind, key, ok := strings.Cut(identity, "\x00")
			if !ok {
				return nil
			}
			n := nodes[key]
			if n == nil {
				return nil
			}
			raw := "*"
			if len(n.args) > 0 {
				raw = aliases[n.args[0].text]
			}
			op := strings.ToLower(n.op)
			if kind == "error" {
				columns = append(columns, "NULL AS "+col.Name)
				continue
			}
			value := ""
			sum := ""
			if raw != "*" {
				// Declined inputs contribute a REAL zero. Thus an INTEGER/NULL
				// SUM proves every consumed value met this plan's domain; numeric
				// text must never be accepted through SQLite's SUM coercion.
				predicate := "typeof(" + raw + ")='integer'"
				if nonnegative {
					predicate += " AND " + raw + ">=0"
				}
				sum = "SUM(CASE WHEN (" + predicate + ") OR " + raw + " IS NULL THEN " + raw + " ELSE 0.0 END)"
				// Non-NULL values must be INTEGER; REAL decimals, malformed storage and
				// out-of-domain values all retain the ordinary compiler's semantics.
				guards = append(guards, "typeof("+sum+") IN ('integer','null')")
				if nonnegative {
					// With negative inputs poisoning the sum, its storage type and
					// final bound prove the entire population's absolute bound.
					guards = append(guards, "COALESCE("+sum+",0)<=9007199254740991")
				} else {
					// Cast before ABS so MIN_INT64 cannot throw. Below 2^53,
					// every addition to this nonnegative TOTAL is exact.
					guards = append(guards, "TOTAL(abs(CAST("+raw+" AS REAL)))<=9007199254740991")
				}
			}
			switch op {
			case "count":
				value = "CAST(COUNT(" + raw + ") AS REAL)"
			case "count_distinct":
				value = "CAST(COUNT(DISTINCT " + raw + ") AS REAL)"
			case "sum":
				value = sum
			case "avg":
				value = "CAST(" + sum + " AS REAL)/NULLIF(COUNT(" + raw + "),0)"
			case "min", "max":
				value = strings.ToUpper(op) + "(" + raw + ")"
			}
			columns = append(columns, value+" AS "+col.Name)
		}
		if len(guards) == 0 {
			guards = append(guards, "1")
		}
		valid := "CASE WHEN " + strings.Join(guards, " AND ") + " THEN 1 ELSE 0 END"
		if len(sourceProof) > 0 {
			valid = "MIN(" + valid + ") OVER ()"
		}
		columns = append(columns, valid+" AS qt_integer_valid")
		by := ""
		if len(groupBy) > 0 {
			by = " GROUP BY " + strings.Join(groupBy, ",")
		}
		sql := "WITH " + inputName + " AS MATERIALIZED (" + input + ") SELECT " + strings.Join(columns, ",") + " FROM " + inputName + by
		if len(sourceProof) > 0 {
			sql += fmt.Sprintf(" LIMIT %d", sourceProof[0].maxGroups+1)
		}
		if nonnegative {
			plan.NonnegativeSQL = sql
		} else {
			plan.SQL = sql
		}
	}
	return plan
}
