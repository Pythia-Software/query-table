package querytable

// compile.go — WireQuery → parameterized SQL fragments.
//
// This is the single chokepoint where a query becomes SQL. It supports
// multi-sort (ORDER BY a, b, … + tiebreaker), synthetic expressions via
// FieldSpec, computed SELECT columns, and text/array operators. Callers splice
// the fragments into their own FROM/JOIN tree.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// postgresWhere is a PostgreSQL WHERE fragment and its ordered bound args.
type postgresWhere struct {
	// WhereSQL is "" when no filters apply, else "(c1) AND (c2) ...". Never
	// includes the WHERE keyword, so callers AND it into their own predicates.
	WhereSQL string
	// Args are the $N bound values, in placeholder order starting at startIdx.
	Args []any
}

// compilePostgresWhere compiles the AND of where terms, each a single
// predicate or an OR group whose members are predicates or AND branches of
// predicates. Relative datetime values resolve against now to bound UTC
// timestamps, never interpolated SQL.
func compilePostgresWhere(where []WhereTerm, schema Schema, startIdx int, now time.Time) (postgresWhere, int, error) {
	var res postgresWhere
	idx := startIdx
	if err := (WireQuery{Where: where}).Validate(); err != nil {
		return res, idx, fmt.Errorf("invalid query: %w", err)
	}
	clauses := make([]string, 0, len(where))
	for _, term := range where {
		var (
			sql  string
			args []any
			next int
			err  error
		)
		if term.IsGroup() {
			sql, args, next, err = compileOrGroup(term.Any, schema, idx, now)
		} else {
			sql, args, next, err = compileLiteral(term.Literal(), schema, idx, now)
		}
		if err != nil {
			return res, idx, err
		}
		if sql == "" {
			continue // skipped (empty value / always-true group)
		}
		clauses = append(clauses, "("+sql+")")
		res.Args = append(res.Args, args...)
		idx = next
	}
	if len(clauses) > 0 {
		res.WhereSQL = strings.Join(clauses, " AND ")
	}
	return res, idx, nil
}

func aggOpKnown(op string) bool {
	switch op {
	case "count", "count_distinct", "sum", "avg", "min", "max":
		return true
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

// compileLiteral validates one predicate against the schema allowlist and emits
// its SQL. A negated predicate is wrapped in a null-exclusive NOT
// (`NOT (<base>) AND <expr> IS NOT NULL`) so a NULL value satisfies neither the
// predicate nor its negation — matching applyQuery and the not_matches_regex
// convention. Returns "" (no SQL) for an empty-value no-op, exactly like the
// positive form.
func compileLiteral(c WhereClause, schema Schema, idx int, reference ...time.Time) (string, []any, int, error) {
	spec, ok := schema.Fields[c.Field]
	if !ok {
		return "", nil, idx, fmt.Errorf("unknown filter field %q", c.Field)
	}
	if !spec.ServerFilter {
		return "", nil, idx, fmt.Errorf("field %q is not server-filterable", c.Field)
	}
	if !fieldOpEnabled(spec, c.Op) {
		return "", nil, idx, fmt.Errorf("field %q: op %q is not enabled", c.Field, c.Op)
	}
	sql, args, next, err := compileWhere(spec, c.Op, c.Value, idx, reference...)
	if err != nil {
		return "", nil, idx, fmt.Errorf("field %q: %w", c.Field, err)
	}
	if sql == "" {
		return "", nil, idx, nil // skipped (empty value)
	}
	if c.Negated {
		if spec.Kind == FieldTextArray {
			sql = fmt.Sprintf("NOT (%s) AND COALESCE(cardinality(%s), 0) > 0", sql, spec.Expr)
		} else {
			sql = fmt.Sprintf("NOT (%s) AND %s IS NOT NULL", sql, spec.Expr)
		}
	}
	return sql, args, next, nil
}

// compileOrGroup compiles a disjunction: `(p1) OR (p2) OR ...`. A member may be
// an {"all": [...]} branch, compiled as `((a) AND (b))`. Every member is
// validated (so an unknown field or disabled op is reported) even when the group
// is dropped. If any disjunct is an always-true no-op (empty value, or a branch
// of only such literals), the whole group is always true and is dropped —
// mirroring applyQuery, where an always-true member short-circuits the OR to
// "match everything".
func compileOrGroup(lits []WhereClause, schema Schema, idx int, reference ...time.Time) (string, []any, int, error) {
	start := idx
	parts := make([]string, 0, len(lits))
	var args []any
	alwaysTrue := false
	for _, c := range lits {
		var (
			sql  string
			a    []any
			next int
			err  error
		)
		if c.IsConjunction() {
			sql, a, next, err = compileConjunction(c.All, schema, idx, reference...)
		} else {
			sql, a, next, err = compileLiteral(c, schema, idx, reference...)
		}
		if err != nil {
			return "", nil, start, err
		}
		if sql == "" {
			alwaysTrue = true // keep validating the rest, then drop the group
			continue
		}
		parts = append(parts, "("+sql+")")
		args = append(args, a...)
		idx = next
	}
	if alwaysTrue || len(parts) == 0 {
		return "", nil, start, nil
	}
	return strings.Join(parts, " OR "), args, idx, nil
}

// compileConjunction compiles one AND branch of an OR group: `(a) AND (b)`.
// An always-true literal (empty value) drops out of the AND; a branch of only
// such literals is always true and returns "".
func compileConjunction(lits []WhereClause, schema Schema, idx int, reference ...time.Time) (string, []any, int, error) {
	start := idx
	parts := make([]string, 0, len(lits))
	var args []any
	for _, c := range lits {
		if c.IsConjunction() {
			return "", nil, start, fmt.Errorf("filter AND branches cannot nest")
		}
		sql, a, next, err := compileLiteral(c, schema, idx, reference...)
		if err != nil {
			return "", nil, start, err
		}
		if sql == "" {
			continue
		}
		parts = append(parts, "("+sql+")")
		args = append(args, a...)
		idx = next
	}
	if len(parts) == 0 {
		return "", nil, start, nil
	}
	return strings.Join(parts, " AND "), args, idx, nil
}

func compileWhere(spec FieldSpec, op, value string, idx int, reference ...time.Time) (string, []any, int, error) {
	switch op {
	case "is_null":
		if spec.Kind == FieldTextArray {
			return fmt.Sprintf("COALESCE(cardinality(%s), 0) = 0", spec.Expr), nil, idx, nil
		}
		return spec.Expr + " IS NULL", nil, idx, nil
	case "is_not_null":
		if spec.Kind == FieldTextArray {
			return fmt.Sprintf("COALESCE(cardinality(%s), 0) > 0", spec.Expr), nil, idx, nil
		}
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
		var v any
		var err error
		if spec.Kind == FieldDatetime && (strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-")) {
			offset, parseErr := parseRelativeDuration(value)
			if parseErr != nil {
				return "", nil, idx, parseErr
			}
			var now time.Time
			if len(reference) > 0 {
				now = reference[0]
			} else {
				now = time.Now()
			}
			v, err = relativeTimestamp(now, offset)
		} else {
			v, err = coerce(spec.Kind, value)
		}
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
	case "length_gt", "length_lt", "length_eq":
		limit, err := strconv.ParseInt(value, 10, 64)
		if err != nil || limit < 0 || limit > 9007199254740991 || strings.HasPrefix(value, "+") || (len(value) > 1 && value[0] == '0') {
			return "", nil, idx, fmt.Errorf("invalid string length %q: expected a non-negative integer", value)
		}
		comparison := ">"
		if op == "length_lt" {
			comparison = "<"
		} else if op == "length_eq" {
			comparison = "="
		}
		return fmt.Sprintf("CHAR_LENGTH(%s) %s $%d::bigint", spec.Expr, comparison, idx), []any{limit}, idx + 1, nil
	case "matches_regex":
		return fmt.Sprintf("(%s)::text ~ $%d", spec.Expr, idx), []any{value}, idx + 1, nil
	case "not_matches_regex":
		return fmt.Sprintf("(%s)::text !~ $%d", spec.Expr, idx), []any{value}, idx + 1, nil
	case "includes":
		if spec.ArrayCaseSensitive {
			return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(%s) AS _e WHERE _e = $%d)", spec.Expr, idx), []any{value}, idx + 1, nil
		}
		// Case-insensitive membership in a text[] column (ARRAY_HAS semantics).
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(%s) AS _e WHERE LOWER(_e) = LOWER($%d))", spec.Expr, idx),
			[]any{value}, idx + 1, nil
	default:
		return "", nil, idx, fmt.Errorf("unknown op %q", op)
	}
}

func fieldOpEnabled(spec FieldSpec, op string) bool {
	if spec.FilterOps == nil {
		return true
	}
	for _, enabled := range spec.FilterOps {
		if enabled == op {
			return true
		}
	}
	return false
}

// opAllowed mirrors @pythia-software/query-table-core OPS_BY_TYPE — the server-side enforcement
// of the operator matrix. Nullity is valid on every kind (incl. bool).
func opAllowed(kind FieldKind, op string) bool {
	switch op {
	case "is_null", "is_not_null":
		return true
	}
	switch kind {
	case FieldText:
		switch op {
		case "=", "!=", "contains", "starts_with", "ends_with", "matches_regex", "not_matches_regex", "length_gt", "length_lt", "length_eq":
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
