package querytable

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// sqliteOptions captures one clock for filters in rows, counts, and metrics.
// Zero Now captures time.Now once per compilation. Share it across a batch.
type sqliteOptions struct{ Now time.Time }

// sqliteWhereResult can be composed with host-owned FROM trees and optimized
// count/rollup queries. It requires only bindings for fields actually filtered;
// a row identity and row ordering are not needed for predicate compilation.
type sqliteWhereResult struct {
	SQL  string
	Args []any
}

func compileSQLiteWhereV1(terms []WhereTerm, s Schema, o sqliteOptions) (sqliteWhereResult, error) {
	result, _, err := compileSQLiteWhere(terms, s, o, nil)
	return result, err
}

// compileSQLiteWhere also applies an execution's host predicate relations and
// reports the key fields they read. With nil relations it is compileSQLiteWhereV1.
func compileSQLiteWhere(terms []WhereTerm, s Schema, o sqliteOptions, relations *sqliteRelations) (sqliteWhereResult, []string, error) {
	result := sqliteWhereResult{}
	if err := (WireQuery{Where: terms}).Validate(); err != nil {
		return result, nil, err
	}
	now := o.Now
	if now.IsZero() {
		now = time.Now()
	}
	var keys []string
	var parts []string
	for _, term := range terms {
		if term.IsGroup() && (len(term.Any) == 0 || term.Field != "" || term.Op != "" || term.Value != "" || term.Negated) {
			return sqliteWhereResult{}, nil, fmt.Errorf("invalid OR group")
		}
		// A term is an OR of AND branches. An always-true literal (blank value)
		// drops out of its branch; a branch with nothing left makes the whole
		// term a no-op, after every literal has still been validated.
		branches := term.Branches()
		literals := make([][]WhereClause, len(branches))
		typed := make([][]sqliteTypedLiteral, len(branches))
		noOp := false
		for i, branch := range branches {
			for _, c := range branch {
				sql, args, err := sqliteBaseLiteral(c, s, now)
				if err != nil {
					return sqliteWhereResult{}, nil, err
				}
				if sql != "" {
					literals[i] = append(literals[i], c)
					typed[i] = append(typed[i], sqliteTypedLiteral{sql, args})
				}
			}
			if len(literals[i]) == 0 {
				noOp = true
			}
		}
		if noOp {
			continue
		}
		var uses [][]*sqliteRelationUse
		if relations != nil {
			var err error
			if uses, err = relations.choose(literals, s); err != nil {
				return sqliteWhereResult{}, nil, err
			}
		}
		var alternatives []string
		for i, branch := range literals {
			var conjuncts []string
			for j, c := range branch {
				var use *sqliteRelationUse
				if uses != nil {
					use = uses[i][j]
				}
				sql, args := sqliteApplyLiteral(c, s.Fields[c.Field], typed[i][j], use)
				if use != nil {
					keys = append(keys, use.field)
				}
				conjuncts = append(conjuncts, "("+sql+")")
				result.Args = append(result.Args, args...)
			}
			if len(conjuncts) == 1 {
				alternatives = append(alternatives, conjuncts[0])
			} else {
				alternatives = append(alternatives, "("+strings.Join(conjuncts, " AND ")+")")
			}
		}
		parts = append(parts, "("+strings.Join(alternatives, " OR ")+")")
	}
	result.SQL = strings.Join(parts, " AND ")
	return result, keys, nil
}

type sqliteTypedLiteral struct {
	sql  string
	args []any
}

// sqliteApplyLiteral emits one non-blank literal. Without a relation it is the
// ordinary typed predicate. An exact relation replaces the typed check; a
// candidate (never chosen for a negated literal) only narrows it. Negation
// always keeps the compiler's null/empty guard, so NULL and empty values
// satisfy neither a predicate nor its negation.
func sqliteApplyLiteral(c WhereClause, f FieldSpec, typed sqliteTypedLiteral, use *sqliteRelationUse) (string, []any) {
	sql, args := typed.sql, typed.args
	if use != nil {
		member := use.key + " IN (" + use.relation.SQL + ")"
		if use.relation.Exact {
			sql, args = member, use.relation.Args
		} else {
			sql = "(" + member + " AND " + sql + ")"
			args = append(append([]any{}, use.relation.Args...), args...)
		}
	}
	if c.Negated {
		sql = "(NOT (" + sql + ") AND NOT (" + sqliteNull(f) + "))"
	}
	return sql, args
}

func validateSQLiteSchema(s Schema) error {
	id, ok := s.Fields[s.IDField]
	if s.Name == "" || s.IDField == "" || !ok || id.Expr == "" || !id.Sortable || (id.Kind != FieldText && id.Kind != FieldEnum && id.Kind != FieldNumber) {
		return fmt.Errorf("SQLite schema requires a bound, sortable idField and a name")
	}
	for name, f := range s.Fields {
		if name == "" || strings.ContainsRune(name, 0) || strings.TrimSpace(f.Expr) == "" {
			return fmt.Errorf("invalid SQLite field %q", name)
		}
		if f.Kind < FieldText || f.Kind > FieldTextArray {
			return fmt.Errorf("invalid kind for SQLite field %q", name)
		}
		if f.SQLiteSortField != "" {
			if target, ok := s.Fields[f.SQLiteSortField]; !ok || target.Expr != f.SortExpr {
				return fmt.Errorf("invalid SQLite sort target for %q", name)
			}
		}
		switch f.SQLiteDatetimeFormat {
		case "", "rfc3339", "utc-millis", "unix-seconds", "unix-millis":
		default:
			return fmt.Errorf("invalid SQLite datetime format for %q", name)
		}
		if f.SQLiteDatetimeFormat != "" && f.Kind != FieldDatetime {
			return fmt.Errorf("datetimeFormat on non-datetime field %q", name)
		}
	}
	for _, order := range append(append([]OrderBy{}, s.DefaultSort...), s.TiebreakSort...) {
		if f, ok := s.Fields[order.Field]; !ok || !f.Sortable {
			return fmt.Errorf("invalid SQLite schema sort field %q", order.Field)
		}
	}
	return nil
}
func sqliteIdent(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
func sqlitePattern(pattern string) (*regexp.Regexp, error) {
	if len(pattern) > maxRegexBytes {
		return nil, fmt.Errorf("regex too long")
	}
	re, e := regexp.Compile(pattern)
	if e != nil {
		return nil, fmt.Errorf("invalid Go/RE2 regex: %w", e)
	}
	return re, nil
}
func sqliteArray(f FieldSpec) string { return "qt_array_json(" + f.Expr + ")" }
func sqliteNull(f FieldSpec) string {
	if f.Kind == FieldTextArray {
		return "json_array_length(" + sqliteArray(f) + ") = 0"
	}
	if f.Kind == FieldText || f.Kind == FieldEnum || f.Kind == FieldDatetime {
		return "(" + f.Expr + " IS NULL OR " + f.Expr + " = '')"
	}
	return f.Expr + " IS NULL"
}
func sqliteDateText(f FieldSpec) string {
	switch f.SQLiteDatetimeFormat {
	case "unix-seconds":
		return "qt_unix_datetime(" + f.Expr + ",1)"
	case "unix-millis":
		return "qt_unix_datetime(" + f.Expr + ",1000)"
	default:
		return "qt_datetime(" + f.Expr + ")"
	}
}
func sqliteLiteral(c WhereClause, s Schema, now time.Time) (string, []any, error) {
	sql, args, err := sqliteBaseLiteral(c, s, now)
	if err != nil || sql == "" {
		return sql, args, err
	}
	sql, args = sqliteApplyLiteral(c, s.Fields[c.Field], sqliteTypedLiteral{sql, args}, nil)
	return sql, args, nil
}

// sqliteBaseLiteral validates one literal and emits its un-negated predicate,
// or "" for a blank no-op value.
func sqliteBaseLiteral(c WhereClause, s Schema, now time.Time) (string, []any, error) {
	f, ok := s.Fields[c.Field]
	if !ok || !f.ServerFilter {
		return "", nil, fmt.Errorf("unknown or disabled filter field %q", c.Field)
	}
	if strings.TrimSpace(f.Expr) == "" || f.Kind < FieldText || f.Kind > FieldTextArray {
		return "", nil, fmt.Errorf("invalid SQLite binding for %q", c.Field)
	}
	if !opAllowed(f.Kind, c.Op) || !fieldOpEnabled(f, c.Op) {
		return "", nil, fmt.Errorf("field %q: op %q is not enabled", c.Field, c.Op)
	}
	if c.Value == "" && c.Op != "is_null" && c.Op != "is_not_null" && ((c.Op != "=" && c.Op != "!=") || (f.Kind != FieldText && f.Kind != FieldEnum)) {
		return "", nil, nil
	}
	expr := f.Expr
	var sql string
	var args []any
	switch c.Op {
	case "is_null":
		sql = sqliteNull(f)
	case "is_not_null":
		sql = "NOT (" + sqliteNull(f) + ")"
	case "=", "!=", ">", ">=", "<", "<=":
		comparisonExpr, value, comparisonOp, constant, err := sqliteComparison(c, f, now)
		if err != nil {
			return "", nil, err
		}
		expr = comparisonExpr
		op := comparisonOp
		if op == "!=" {
			op = "<>"
		}
		sql = expr + " " + op + " ?"
		args = []any{value}
		if c.Op == "!=" && f.Kind != FieldText && f.Kind != FieldEnum {
			sql = "(" + expr + " IS NULL OR " + sql + ")"
		}
		if constant != "" {
			sql = constant
			args = nil
		}
	case "contains", "starts_with":
		cmp := "> 0"
		if c.Op == "starts_with" {
			cmp = "= 1"
		}
		sql = "instr(qt_lower(" + expr + "),qt_lower(?)) " + cmp
		args = []any{c.Value}
	case "ends_with":
		sql = "qt_ends_with(" + expr + ",?)"
		args = []any{c.Value}
	case "length_gt", "length_lt", "length_eq":
		limit, e := strconv.ParseInt(c.Value, 10, 64)
		if e != nil || limit < 0 || limit > sqliteSafeInteger || strings.HasPrefix(c.Value, "+") || (len(c.Value) > 1 && c.Value[0] == '0') {
			return "", nil, fmt.Errorf("invalid string length %q", c.Value)
		}
		op := map[string]string{"length_gt": ">", "length_lt": "<", "length_eq": "="}[c.Op]
		sql = "qt_length(" + expr + ") " + op + " ?"
		args = []any{limit}
	case "matches_regex", "not_matches_regex":
		if _, e := sqlitePattern(c.Value); e != nil {
			return "", nil, e
		}
		sql = "qt_regexp(?,CAST(" + expr + " AS TEXT))"
		if c.Op == "not_matches_regex" {
			sql = "NOT (" + sql + ")"
		}
		args = []any{c.Value}
	case "includes":
		comparison := "_qt_element.value COLLATE BINARY = ?"
		if !f.ArrayCaseSensitive {
			comparison = "qt_lower(_qt_element.value) = qt_lower(?)"
		}
		sql = "EXISTS (SELECT 1 FROM json_each(" + sqliteArray(f) + ") AS _qt_element WHERE " + comparison + ")"
		args = []any{c.Value}
	}
	return sql, args, nil
}

// sqliteComparison shares literal coercion, relative clocks and indexed datetime
// boundary rounding between SQL compilation and the in-memory row filter.
func sqliteComparison(c WhereClause, f FieldSpec, now time.Time) (expr string, value any, comparisonOp, constant string, err error) {
	expr = f.Expr
	value = c.Value
	comparisonOp = c.Op
	constant = ""
	if f.Kind == FieldDatetime {
		var t time.Time
		var err error
		if strings.HasPrefix(c.Value, "+") || strings.HasPrefix(c.Value, "-") {
			offset, e := parseRelativeDuration(c.Value)
			err = e
			if e == nil {
				t, err = relativeTimestamp(now, offset)
			}
		} else {
			t, err = sqliteParseTime(c.Value)
		}
		if err != nil {
			return "", nil, "", "", err
		}
		if t.UTC().Year() < 0 || t.UTC().Year() > 9999 {
			return "", nil, "", "", fmt.Errorf("datetime outside years 0000..9999")
		}
		switch f.SQLiteDatetimeFormat {
		case "utc-millis":
			// Keep indexed comparisons exact when a filter lies between stored milliseconds.
			if remainder := t.Nanosecond() % 1_000_000; remainder != 0 {
				switch c.Op {
				case "=":
					constant = "0"
				case "!=":
					constant = "1"
				case ">", ">=":
					comparisonOp = ">="
					t = t.Add(time.Duration(1_000_000 - remainder))
					if t.UTC().Year() > 9999 {
						constant = "0"
					}
				case "<", "<=":
					comparisonOp = "<="
					t = t.Add(-time.Duration(remainder))
				}
			}
			value = t.UTC().Format("2006-01-02T15:04:05.000Z")
		case "unix-millis":
			value = float64(t.Unix())*1000 + float64(t.Nanosecond())/1e6
		case "unix-seconds":
			value = float64(t.Unix()) + float64(t.Nanosecond())/1e9
		default:
			expr = "qt_datetime(" + expr + ")"
			value = t.UTC().Format("2006-01-02T15:04:05.000000000Z")
		}
	} else if f.Kind == FieldNumber || f.Kind == FieldBool {
		v, e := coerce(f.Kind, c.Value)
		if e != nil {
			return "", nil, "", "", e
		}
		value = v
		if n, ok := v.(float64); ok && (math.IsNaN(n) || math.IsInf(n, 0)) {
			return "", nil, "", "", fmt.Errorf("filter requires a finite number")
		}
	} else {
		expr = "COALESCE(" + expr + ",'') COLLATE BINARY"
	}
	return expr, value, comparisonOp, constant, nil
}
