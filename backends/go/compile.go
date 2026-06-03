package querytable

// compile.go — WireQuery → parameterized SQL fragments.
//
// This is the single chokepoint where a query becomes SQL. It generalizes
// explo's perfstore.Compile with: multi-sort (ORDER BY a, b, … + tiebreaker),
// synthetic expressions via FieldSpec, computed SELECT columns, and the extra
// xlsx-collect operators (starts_with / ends_with / includes / textarray
// nullity). Callers splice the fragments into their own FROM/JOIN tree.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// CompileResult holds the SQL fragments plus their ordered bound args.
type CompileResult struct {
	// WhereSQL is "" when no filters apply, else "(c1) AND (c2) ...". Never
	// includes the WHERE keyword, so callers AND it into their own predicates.
	WhereSQL string
	// OrderSQL is "" to use the schema default, else
	// "expr DIR NULLS x, expr2 DIR2 NULLS y, <tiebreak...>".
	OrderSQL string
	// SelectExprs are "<expr> AS <safe_alias>" for each requested backend field.
	SelectExprs []string
	// Args are the $N bound values, in placeholder order starting at startIdx.
	Args []any
}

// Compile validates q against schema and emits SQL fragments. startIdx is the
// 1-based pgx placeholder index for the first bound value, so callers can
// interleave their own params; the returned int is the next free index.
//
// Errors (never a panic) on: unknown field, an operator not allowed for a
// field's kind, a filter on a non-server-filterable field, a sort on a
// non-sortable field, an unknown select field, or a value that fails coercion.
func Compile(q WireQuery, schema Schema, startIdx int) (CompileResult, int, error) {
	var res CompileResult
	idx := startIdx

	// WHERE
	clauses := make([]string, 0, len(q.Where))
	for _, c := range q.Where {
		spec, ok := schema.Fields[c.Field]
		if !ok {
			return res, idx, fmt.Errorf("unknown filter field %q", c.Field)
		}
		if !spec.ServerFilter {
			return res, idx, fmt.Errorf("field %q is not server-filterable", c.Field)
		}
		sql, args, next, err := compileWhere(spec, c.Op, c.Value, idx)
		if err != nil {
			return res, idx, fmt.Errorf("field %q: %w", c.Field, err)
		}
		if sql == "" {
			continue // skipped (empty value)
		}
		clauses = append(clauses, "("+sql+")")
		res.Args = append(res.Args, args...)
		idx = next
	}
	if len(clauses) > 0 {
		res.WhereSQL = strings.Join(clauses, " AND ")
	}

	// ORDER BY (multi-sort) + tiebreak
	terms := make([]string, 0, len(q.OrderBy)+len(schema.TiebreakSort))
	for _, ob := range q.OrderBy {
		spec, ok := schema.Fields[ob.Field]
		if !ok {
			return res, idx, fmt.Errorf("unknown sort field %q", ob.Field)
		}
		if !spec.Sortable {
			return res, idx, fmt.Errorf("field %q is not sortable", ob.Field)
		}
		t, err := orderTerm(spec.SortExpr, ob.Dir, ob.Nulls)
		if err != nil {
			return res, idx, fmt.Errorf("field %q: %w", ob.Field, err)
		}
		terms = append(terms, t)
	}
	if len(terms) > 0 {
		for _, tb := range schema.TiebreakSort {
			if spec, ok := schema.Fields[tb.Field]; ok {
				if t, err := orderTerm(spec.SortExpr, tb.Dir, tb.Nulls); err == nil {
					terms = append(terms, t)
				}
			}
		}
		res.OrderSQL = strings.Join(terms, ", ")
	}

	// SELECT (computed/backed columns the caller asked to project)
	for _, name := range q.Select {
		spec, ok := schema.Fields[name]
		if !ok {
			return res, idx, fmt.Errorf("unknown select field %q", name)
		}
		res.SelectExprs = append(res.SelectExprs, fmt.Sprintf("%s AS %s", spec.Expr, safeIdent(name)))
	}

	return res, idx, nil
}

// AggCompileResult holds the SQL fragments for one metric's GROUP BY query. The
// caller splices them into its own FROM/JOIN, sharing the rows query's WHERE so
// the metric covers the same filtered set (scope = whole set, no paging):
//
//	SELECT <SelectExprs joined by ", ">
//	FROM   <caller FROM/JOIN>
//	[WHERE <Compile(WireQuery{Where: req.Where}, …).WhereSQL>]
//	[GROUP BY <GroupBySQL>]
//
// SelectExprs is, in order: one `expr AS "g0"/"g1"/…` per group field, then the
// aggregate `AS "value"`, then `COUNT(*) AS "count"`. GroupBySQL lists the same
// group expressions (empty string ⇒ a single grand-total row, no GROUP BY).
type AggCompileResult struct {
	SelectExprs []string
	GroupBySQL  string
}

// CompileAggregation validates one AggSpec against the schema allowlist and emits
// its SELECT + GROUP BY fragments. Like Compile, the only request-influenced
// tokens that reach SQL are the validated op and the schema-defined field
// expressions — never request input. No bound args are produced (aggregations
// carry no values; the shared WHERE is compiled separately via Compile).
//
// Errors on: unknown op, unknown measure/group field, a missing measure for an
// op that needs one, or an op not allowed for the measure field's kind.
func CompileAggregation(spec AggSpec, schema Schema) (AggCompileResult, error) {
	var res AggCompileResult
	if !aggOpKnown(spec.Op) {
		return res, fmt.Errorf("unknown aggregate op %q", spec.Op)
	}

	groupExprs := make([]string, 0, len(spec.GroupBy))
	for i, g := range spec.GroupBy {
		gs, ok := schema.Fields[g]
		if !ok {
			return res, fmt.Errorf("unknown group field %q", g)
		}
		res.SelectExprs = append(res.SelectExprs, fmt.Sprintf("%s AS %s", gs.Expr, safeIdent(fmt.Sprintf("g%d", i))))
		groupExprs = append(groupExprs, gs.Expr)
	}

	valueExpr, err := aggValueExpr(spec, schema)
	if err != nil {
		return res, err
	}
	res.SelectExprs = append(res.SelectExprs, valueExpr+` AS "value"`, `COUNT(*) AS "count"`)

	if len(groupExprs) > 0 {
		res.GroupBySQL = strings.Join(groupExprs, ", ")
	}
	return res, nil
}

// aggValueExpr builds the aggregate SELECT expression. `count` with no field is
// COUNT(*) (counts rows); with a field it counts non-null values.
func aggValueExpr(spec AggSpec, schema Schema) (string, error) {
	if spec.Op == "count" && spec.Field == "" {
		return "COUNT(*)", nil
	}
	if spec.Field == "" {
		return "", fmt.Errorf("aggregate op %q requires a measure field", spec.Op)
	}
	fs, ok := schema.Fields[spec.Field]
	if !ok {
		return "", fmt.Errorf("unknown measure field %q", spec.Field)
	}
	if !aggOpAllowed(fs.Kind, spec.Op) {
		return "", fmt.Errorf("aggregate op %q not allowed on %s field", spec.Op, kindName(fs.Kind))
	}
	switch spec.Op {
	case "count":
		return "COUNT(" + fs.Expr + ")", nil
	case "count_distinct":
		return "COUNT(DISTINCT " + fs.Expr + ")", nil
	case "sum":
		return "SUM(" + fs.Expr + ")", nil
	case "avg":
		return "AVG(" + fs.Expr + ")", nil
	case "min":
		return "MIN(" + fs.Expr + ")", nil
	case "max":
		return "MAX(" + fs.Expr + ")", nil
	default:
		return "", fmt.Errorf("unknown aggregate op %q", spec.Op)
	}
}

func aggOpKnown(op string) bool {
	switch op {
	case "count", "count_distinct", "sum", "avg", "min", "max":
		return true
	}
	return false
}

// aggOpAllowed mirrors @query-table/core AGG_OPS_BY_TYPE — the server-side
// enforcement of which aggregate ops a field's kind permits. Keep in lockstep.
func aggOpAllowed(kind FieldKind, op string) bool {
	switch kind {
	case FieldNumber:
		switch op {
		case "count", "count_distinct", "sum", "avg", "min", "max":
			return true
		}
	case FieldDatetime, FieldEnum, FieldText:
		switch op {
		case "count", "count_distinct", "min", "max":
			return true
		}
	case FieldBool:
		switch op {
		case "count", "count_distinct":
			return true
		}
	case FieldTextArray:
		return op == "count"
	}
	return false
}

func orderTerm(expr, dir, nulls string) (string, error) {
	d := "ASC"
	if strings.EqualFold(dir, "desc") {
		d = "DESC"
	}
	n := "NULLS LAST"
	switch strings.ToLower(nulls) {
	case "", "last":
		n = "NULLS LAST"
	case "first":
		n = "NULLS FIRST"
	default:
		return "", fmt.Errorf("unknown nulls position %q", nulls)
	}
	return expr + " " + d + " " + n, nil
}

func compileWhere(spec FieldSpec, op, value string, idx int) (string, []any, int, error) {
	switch op {
	case "is_null":
		return spec.Expr + " IS NULL", nil, idx, nil
	case "is_not_null":
		return spec.Expr + " IS NOT NULL", nil, idx, nil
	}
	if !opAllowed(spec.Kind, op) {
		return "", nil, idx, fmt.Errorf("op %q not allowed on %s field", op, kindName(spec.Kind))
	}
	// Empty value: a cleared input is a "no filter" signal (matches the frontend
	// + applyQuery), except =/!= on text/enum where "" is a legitimate compare.
	if value == "" {
		switch op {
		case "=", "!=":
			if spec.Kind != FieldText && spec.Kind != FieldEnum {
				return "", nil, idx, nil
			}
		default:
			return "", nil, idx, nil
		}
	}

	switch op {
	case "=", "!=", ">", ">=", "<", "<=":
		sqlOp := op
		if op == "!=" {
			sqlOp = "<>"
		}
		v, err := coerce(spec.Kind, value)
		if err != nil {
			return "", nil, idx, err
		}
		return fmt.Sprintf("%s %s $%d", spec.Expr, sqlOp, idx), []any{v}, idx + 1, nil

	case "contains":
		// Literal case-insensitive substring (POSITION, not ILIKE) so % and _ in
		// the user's value don't silently become wildcards.
		return fmt.Sprintf("POSITION(LOWER($%d) IN LOWER(%s)) > 0", idx, spec.Expr), []any{value}, idx + 1, nil
	case "starts_with":
		return fmt.Sprintf("POSITION(LOWER($%d) IN LOWER(%s)) = 1", idx, spec.Expr), []any{value}, idx + 1, nil
	case "ends_with":
		return fmt.Sprintf("RIGHT(LOWER(%s), LENGTH($%d)) = LOWER($%d)", spec.Expr, idx, idx), []any{value}, idx + 1, nil
	case "includes":
		// Case-insensitive membership in a text[] column (ARRAY_HAS semantics).
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(%s) AS _e WHERE LOWER(_e) = LOWER($%d))", spec.Expr, idx),
			[]any{value}, idx + 1, nil
	default:
		return "", nil, idx, fmt.Errorf("unknown op %q", op)
	}
}

// opAllowed mirrors @query-table/core OPS_BY_TYPE — the server-side enforcement
// of the operator matrix. Nullity is valid on every kind (incl. bool).
func opAllowed(kind FieldKind, op string) bool {
	switch op {
	case "is_null", "is_not_null":
		return true
	}
	switch kind {
	case FieldText:
		switch op {
		case "=", "!=", "contains", "starts_with", "ends_with":
			return true
		}
	case FieldEnum:
		switch op {
		case "=", "!=":
			return true
		}
	case FieldNumber, FieldDatetime:
		switch op {
		case "=", "!=", ">", ">=", "<", "<=":
			return true
		}
	case FieldBool:
		switch op {
		case "=", "!=":
			return true
		}
	case FieldTextArray:
		switch op {
		case "includes":
			return true
		}
	}
	return false
}

func coerce(kind FieldKind, v string) (any, error) {
	switch kind {
	case FieldNumber:
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nil, fmt.Errorf("not a number: %q", v)
		}
		return f, nil
	case FieldBool:
		switch strings.ToLower(v) {
		case "true", "1", "t":
			return true, nil
		case "false", "0", "f":
			return false, nil
		default:
			return nil, fmt.Errorf("not a bool: %q", v)
		}
	case FieldDatetime:
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			return t, nil
		}
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t, nil
		}
		if t, err := time.Parse("2006-01-02", v); err == nil {
			return t, nil
		}
		return nil, fmt.Errorf("not an RFC3339 datetime: %q", v)
	default:
		return v, nil
	}
}

// DistinctCompile holds the fragments for an autocomplete distinct-values query.
// The caller assembles them into its own FROM/JOIN tree:
//
//	SELECT DISTINCT <Expr> AS v FROM ... WHERE <Expr> IS NOT NULL [AND <SearchSQL>]
//	ORDER BY v LIMIT <n+1>   -- fetch one extra to compute hasMore
type DistinctCompile struct {
	Expr      string
	SearchSQL string // "" when search is empty
	Args      []any
}

type DistinctHasNullCompile struct {
	IsNullExpr string
}

// CompileDistinct builds the fragments to back filter-value autocomplete for a
// field (design feedback: every field is an autocomplete by default). The search
// is a literal case-insensitive substring (no wildcard injection).
func CompileDistinct(field, search string, schema Schema, startIdx int) (DistinctCompile, int, error) {
	spec, ok := schema.Fields[field]
	if !ok {
		return DistinctCompile{}, startIdx, fmt.Errorf("unknown field %q", field)
	}
	dc := DistinctCompile{Expr: spec.Expr}
	idx := startIdx
	if search != "" {
		dc.SearchSQL = fmt.Sprintf("POSITION(LOWER($%d) IN LOWER(%s::text)) > 0", idx, spec.Expr)
		dc.Args = append(dc.Args, search)
		idx++
	}
	return dc, idx, nil
}

// CompileDistinctHasNull builds the nullability expression for the same field-aware
// distinct path used by value autocomplete. It is intended for a lightweight
// metadata query that answers “does this field have any nulls?” without another
// independent field lookup path in callers.
func CompileDistinctHasNull(field string, schema Schema) (DistinctHasNullCompile, error) {
	spec, ok := schema.Fields[field]
	if !ok {
		return DistinctHasNullCompile{}, fmt.Errorf("unknown field %q", field)
	}
	return DistinctHasNullCompile{IsNullExpr: spec.Expr + " IS NULL"}, nil
}

func kindName(k FieldKind) string {
	switch k {
	case FieldText:
		return "text"
	case FieldNumber:
		return "number"
	case FieldDatetime:
		return "datetime"
	case FieldBool:
		return "bool"
	case FieldEnum:
		return "enum"
	case FieldTextArray:
		return "textarray"
	default:
		return "unknown"
	}
}

// safeIdent makes a SELECT alias from a (schema-validated) field name. Field
// names already pass the schema's name pattern, but we defensively strip
// anything that isn't an identifier char so an alias can never break out.
func safeIdent(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if s == "" {
		s = "col"
	}
	return "\"" + s + "\""
}
