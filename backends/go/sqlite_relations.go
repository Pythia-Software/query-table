package querytable

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// SQLitePredicate is one filter literal offered to a host relation provider.
// Value is the request's literal text; Negated reports that the compiler will
// negate the predicate (a provider may decline negated predicates).
type SQLitePredicate struct {
	Field   string
	Op      string
	Value   string
	Negated bool
}

// SQLitePredicateRelation is a host-owned SQL relation for one predicate.
//
// SQL is a SELECT returning a single column of Key values: the rows that
// satisfy the un-negated predicate. The compiler emits `<key> IN (<SQL>)`
// inside the same statement as the query, so the relation always reads the
// execution's own transaction and data snapshot; it is never materialized
// separately. SQL is trusted host input with anonymous ? parameters bound to
// Args in order. It must not contain comments, numbered or named parameters,
// or statement separators, and must not refer to compiler names (CTEs qt0,
// qt1, … and row aliases such as f0, v0, e0).
//
// Key names the schema field whose values the relation yields; empty means the
// schema IDField. Key values must be non-NULL and identify source rows, so a
// predicate's truth is a function of the key. A relation whose key is not
// bound in the schema being compiled (for example a staged projection that
// omitted it) is ignored and the ordinary predicate applies.
//
// Exact asserts that the relation is complete and equals the predicate's
// rows: the typed check is then replaced, including for negation. A
// candidate (Exact false) is a superset that only narrows: the typed check
// still runs, and a negated candidate is ignored. Hosts must report Exact only
// once every row of the snapshot is represented (for example after an index
// backfill completes); answer a candidate or decline otherwise. A replaced
// predicate does not evaluate the field, so per-value function errors the
// typed check would raise (invalid UTF-8, oversized text) do not occur.
type SQLitePredicateRelation struct {
	SQL   string
	Args  []any
	Key   string
	Exact bool
}

// SQLitePredicateRelations supplies relations for SQLite filter predicates.
// It is consulted while compiling an execution, with that execution's context
// and transaction, at most once per distinct predicate. Return ok false to
// keep the ordinary predicate. A returned error fails the execution.
//
// Relations apply to base-field predicates in rows (SQLiteDataset,
// SQLiteV2Dataset), /metrics V2 populations and metric filters, and
// /query-v3 source and row filters. They never apply to group filters over
// grouped results, to computed fields, or to ExecuteV2Rows. Inside an OR
// term they are used only when every branch has a usable relation;
// otherwise the whole term keeps its ordinary predicates.
type SQLitePredicateRelations interface {
	PredicateRelation(ctx context.Context, tx *sql.Tx, p SQLitePredicate) (relation SQLitePredicateRelation, ok bool, err error)
}

// SQLitePredicateRelationsFunc adapts a function to SQLitePredicateRelations.
type SQLitePredicateRelationsFunc func(ctx context.Context, tx *sql.Tx, p SQLitePredicate) (SQLitePredicateRelation, bool, error)

func (f SQLitePredicateRelationsFunc) PredicateRelation(ctx context.Context, tx *sql.Tx, p SQLitePredicate) (SQLitePredicateRelation, bool, error) {
	return f(ctx, tx, p)
}

// sqliteRelations binds a provider to one execution. Decisions are cached so
// every statement of the execution sees the same relation for a predicate.
type sqliteRelations struct {
	ctx      context.Context
	tx       *sql.Tx
	provider SQLitePredicateRelations
	cache    map[SQLitePredicate]sqliteRelationAnswer
}
type sqliteRelationAnswer struct {
	relation SQLitePredicateRelation
	ok       bool
	err      error
}

func newSQLiteRelations(ctx context.Context, tx *sql.Tx, provider SQLitePredicateRelations) *sqliteRelations {
	if provider == nil {
		return nil
	}
	return &sqliteRelations{ctx: ctx, tx: tx, provider: provider, cache: map[SQLitePredicate]sqliteRelationAnswer{}}
}

func (r *sqliteRelations) lookup(c WhereClause) (SQLitePredicateRelation, bool, error) {
	p := SQLitePredicate{Field: c.Field, Op: c.Op, Value: c.Value, Negated: c.Negated}
	if answer, ok := r.cache[p]; ok {
		return answer.relation, answer.ok, answer.err
	}
	relation, ok, err := r.provider.PredicateRelation(r.ctx, r.tx, p)
	if err == nil && ok {
		relation.Args = append([]any{}, relation.Args...)
		err = validateSQLiteRelation(relation)
	}
	if err != nil {
		relation, ok = SQLitePredicateRelation{}, false
		err = &sqliteRelationError{field: c.Field, op: c.Op, err: err}
	}
	r.cache[p] = sqliteRelationAnswer{relation, ok, err}
	return relation, ok, err
}

// sqliteRelationError is a host provider failure. It fails the execution
// rather than becoming one metric's clause error or a request diagnostic.
type sqliteRelationError struct {
	field, op string
	err       error
}

func (e *sqliteRelationError) Error() string {
	return fmt.Sprintf("predicate relation for %q %s: %v", e.field, e.op, e.err)
}
func (e *sqliteRelationError) Unwrap() error { return e.err }

// validateSQLiteRelation checks the host fragment can be spliced as one
// parenthesized subquery whose anonymous parameters match Args. Quoting
// follows sqliteNumberParameters, which later numbers the same ? markers.
func validateSQLiteRelation(r SQLitePredicateRelation) error {
	if strings.TrimSpace(r.SQL) == "" || strings.ContainsRune(r.SQL, 0) {
		return fmt.Errorf("relation SQL is required")
	}
	if strings.HasPrefix(r.Key, "@computed/") {
		return fmt.Errorf("relation key must be a base field")
	}
	params, depth := 0, 0
	var quote byte
	s := r.SQL
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == quote {
				if i+1 < len(s) && s[i+1] == quote {
					i++
				} else {
					quote = 0
				}
			}
			continue
		}
		next := byte(0)
		if i+1 < len(s) {
			next = s[i+1]
		}
		switch {
		case c == '\'' || c == '"' || c == '`':
			quote = c
		case c == '?':
			if next >= '0' && next <= '9' {
				return fmt.Errorf("relation SQL must use anonymous ? parameters")
			}
			params++
		case c == ':' || c == '@' || c == '$':
			return fmt.Errorf("relation SQL must use anonymous ? parameters")
		case c == '[':
			return fmt.Errorf("relation SQL must quote identifiers with double quotes")
		case c == ';':
			return fmt.Errorf("relation SQL must be one SELECT")
		case c == '-' && next == '-', c == '/' && next == '*':
			return fmt.Errorf("relation SQL must not contain comments")
		case c == '(':
			depth++
		case c == ')':
			depth--
			if depth < 0 {
				return fmt.Errorf("relation SQL has unbalanced parentheses")
			}
		}
	}
	if quote != 0 || depth != 0 {
		return fmt.Errorf("relation SQL has unbalanced quotes or parentheses")
	}
	if params != len(r.Args) {
		return fmt.Errorf("relation SQL has %d parameters for %d args", params, len(r.Args))
	}
	return nil
}

// sqliteRelationUse is a decided relation for one compiled literal.
type sqliteRelationUse struct {
	relation SQLitePredicateRelation
	key      string // bound key expression in the schema being compiled
	field    string // key field name
}

// choose decides which literals of one OR-of-AND term use a host relation.
// lits holds each branch's non-blank literals. A literal can use an exact
// relation (positive or negated) or a positive candidate. With more than one
// branch, relations are used only if every branch has at least one usable
// literal; otherwise the term keeps every ordinary predicate. A nil result
// means no relation applies to the term.
func (r *sqliteRelations) choose(lits [][]WhereClause, s Schema) ([][]*sqliteRelationUse, error) {
	uses := make([][]*sqliteRelationUse, len(lits))
	covered := 0
	for i, branch := range lits {
		uses[i] = make([]*sqliteRelationUse, len(branch))
		usable := false
		for j, c := range branch {
			if strings.HasPrefix(c.Field, "@computed/") {
				continue
			}
			relation, ok, err := r.lookup(c)
			if err != nil {
				return nil, err
			}
			if !ok || (!relation.Exact && c.Negated) {
				continue
			}
			name := relation.Key
			if name == "" {
				name = s.IDField
			}
			key, bound := s.Fields[name]
			if !bound || strings.HasPrefix(name, "@computed/") || key.Kind == FieldTextArray || strings.TrimSpace(key.Expr) == "" {
				continue
			}
			uses[i][j] = &sqliteRelationUse{relation: relation, key: key.Expr, field: name}
			usable = true
		}
		if usable {
			covered++
		}
	}
	if len(lits) > 1 && covered < len(lits) {
		return nil, nil
	}
	if covered == 0 {
		return nil, nil
	}
	return uses, nil
}
