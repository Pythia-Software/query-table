package querytable

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// relationProvider answers from a table keyed by field+op. Exact answers for
// "text contains", a candidate for "text starts_with", and nothing otherwise.
type relationProvider struct {
	calls     []SQLitePredicate
	answers   map[string]SQLitePredicateRelation
	declineNo bool // decline negated predicates
	err       error
}

func (p *relationProvider) PredicateRelation(_ context.Context, _ *sql.Tx, q SQLitePredicate) (SQLitePredicateRelation, bool, error) {
	p.calls = append(p.calls, q)
	if p.err != nil {
		return SQLitePredicateRelation{}, false, p.err
	}
	if p.declineNo && q.Negated {
		return SQLitePredicateRelation{}, false, nil
	}
	r, ok := p.answers[q.Field+" "+q.Op]
	if ok {
		r.Args = []any{strings.ToLower(q.Value)}
	}
	return r, ok, nil
}

func newRelationProvider() *relationProvider {
	return &relationProvider{answers: map[string]SQLitePredicateRelation{
		"text contains":    {SQL: "SELECT id FROM idx WHERE body MATCH ?", Exact: true},
		"text starts_with": {SQL: "SELECT id FROM idx WHERE body MATCH ?"},
		"n =":              {SQL: "SELECT id FROM numbers WHERE n = ?", Key: "missing", Exact: true},
	}}
}

func literalTerm(c WhereClause) WhereTerm {
	return WhereTerm{Field: c.Field, Op: c.Op, Value: c.Value, Negated: c.Negated}
}

func compileWithRelations(t *testing.T, p SQLitePredicateRelations, where ...WhereTerm) (SQLiteWhereResult, []string) {
	t.Helper()
	got, keys, err := compileSQLiteWhere(where, sqliteTestSchema(), SQLiteOptions{Now: time.Unix(0, 0)}, newSQLiteRelations(context.Background(), nil, p))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(got.SQL, "?") != len(got.Args) {
		t.Fatalf("%d placeholders for %d args in %s", strings.Count(got.SQL, "?"), len(got.Args), got.SQL)
	}
	return got, keys
}

func TestSQLitePredicateRelationDecisions(t *testing.T) {
	contains := WhereClause{Field: "text", Op: "contains", Value: "Needle"}
	starts := WhereClause{Field: "text", Op: "starts_with", Value: "Pre"}
	regex := WhereClause{Field: "text", Op: "matches_regex", Value: "x+"}
	negated := contains
	negated.Negated = true
	negatedStarts := starts
	negatedStarts.Negated = true
	member := "r.id IN (SELECT id FROM idx WHERE body MATCH ?)"
	typedContains := "instr(qt_lower(r.text),qt_lower(?)) > 0"
	typedStarts := "instr(qt_lower(r.text),qt_lower(?)) = 1"
	guard := "NOT ((r.text IS NULL OR r.text = ''))"
	cases := []struct {
		name     string
		where    []WhereTerm
		sql      string
		args     []any
		replaced bool
	}{
		{"exact replaces the typed check", []WhereTerm{literalTerm(contains)}, "((" + member + "))", []any{"needle"}, true},
		{"candidate keeps the typed check", []WhereTerm{literalTerm(starts)}, "(((" + member + " AND " + typedStarts + ")))", []any{"pre", "Pre"}, true},
		{"negated exact keeps the null and empty guard", []WhereTerm{literalTerm(negated)}, "(((NOT (" + member + ") AND " + guard + ")))", []any{"needle"}, true},
		{"negated candidate is ignored", []WhereTerm{literalTerm(negatedStarts)}, "(((NOT (" + typedStarts + ") AND " + guard + ")))", []any{"Pre"}, false},
		{"unsupported operator stays typed", []WhereTerm{literalTerm(regex)}, "((qt_regexp(?,CAST(r.text AS TEXT))))", []any{"x+"}, false},
		{"unbound key stays typed", []WhereTerm{{Field: "n", Op: "=", Value: "3"}}, "((r.n = ?))", []any{float64(3)}, false},
		{"OR with every branch covered", []WhereTerm{{Any: []WhereClause{contains, starts}}}, "((" + member + ") OR ((" + member + " AND " + typedStarts + ")))", []any{"needle", "pre", "Pre"}, true},
		{"OR with an uncovered branch stays typed", []WhereTerm{{Any: []WhereClause{contains, regex}}}, "((" + typedContains + ") OR (qt_regexp(?,CAST(r.text AS TEXT))))", []any{"Needle", "x+"}, false},
		{"OR with a negated candidate branch stays typed", []WhereTerm{{Any: []WhereClause{contains, negatedStarts}}}, "((" + typedContains + ") OR ((NOT (" + typedStarts + ") AND " + guard + ")))", []any{"Needle", "Pre"}, false},
		{"OR of ANDs with a relation in every branch", []WhereTerm{{Any: []WhereClause{
			{All: []WhereClause{contains, {Field: "n", Op: ">", Value: "1"}}},
			{All: []WhereClause{regex, negated}},
		}}}, "(((" + member + ") AND (r.n > ?)) OR ((qt_regexp(?,CAST(r.text AS TEXT))) AND ((NOT (" + member + ") AND " + guard + "))))", []any{"needle", float64(1), "x+", "needle"}, true},
		{"OR of ANDs with an uncovered branch stays typed", []WhereTerm{{Any: []WhereClause{
			{All: []WhereClause{contains, {Field: "n", Op: ">", Value: "1"}}},
			{All: []WhereClause{regex, {Field: "n", Op: "<", Value: "0"}}},
		}}}, "(((" + typedContains + ") AND (r.n > ?)) OR ((qt_regexp(?,CAST(r.text AS TEXT))) AND (r.n < ?)))", []any{"Needle", float64(1), "x+", float64(0)}, false},
		{"terms decide independently", []WhereTerm{literalTerm(contains), {Any: []WhereClause{contains, regex}}}, "((" + member + ")) AND ((" + typedContains + ") OR (qt_regexp(?,CAST(r.text AS TEXT))))", []any{"needle", "Needle", "x+"}, true},
	}
	for _, c := range cases {
		got, keys := compileWithRelations(t, newRelationProvider(), c.where...)
		if got.SQL != c.sql || !reflect.DeepEqual(got.Args, c.args) {
			t.Errorf("%s:\n got %s %v\nwant %s %v", c.name, got.SQL, got.Args, c.sql, c.args)
		}
		if (len(keys) > 0) != c.replaced {
			t.Errorf("%s: relation keys %v", c.name, keys)
		}
	}
}

func TestSQLitePredicateRelationsLeaveOrdinaryCompilationUnchanged(t *testing.T) {
	where := []WhereTerm{
		{Field: "text", Op: "contains", Value: "Needle", Negated: true},
		{Any: []WhereClause{{Field: "text", Op: "starts_with", Value: "a"}, {All: []WhereClause{{Field: "n", Op: ">", Value: "2"}, {Field: "tags", Op: "includes", Value: "x"}}}}},
	}
	plain, err := CompileSQLiteWhere(where, sqliteTestSchema(), SQLiteOptions{Now: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	declined := &relationProvider{answers: map[string]SQLitePredicateRelation{}}
	got, keys := compileWithRelations(t, declined, where...)
	if !reflect.DeepEqual(got, plain) || len(keys) != 0 {
		t.Fatalf("declined provider changed SQL:\n%#v\n%#v", got, plain)
	}
	none, _, err := compileSQLiteWhere(where, sqliteTestSchema(), SQLiteOptions{Now: time.Unix(0, 0)}, newSQLiteRelations(context.Background(), nil, nil))
	if err != nil || !reflect.DeepEqual(none, plain) {
		t.Fatalf("nil provider changed SQL: %v", err)
	}
	if newSQLiteRelations(context.Background(), nil, nil) != nil {
		t.Fatal("nil provider bound")
	}
}

func TestSQLitePredicateRelationConsultation(t *testing.T) {
	p := newRelationProvider()
	relations := newSQLiteRelations(context.Background(), nil, p)
	where := []WhereTerm{
		{Field: "text", Op: "contains", Value: ""},           // blank: a no-op, never offered
		{Field: "@computed/x", Op: "contains", Value: "abc"}, // computed: never offered
		{Field: "text", Op: "contains", Value: "abc"},
	}
	s := sqliteTestSchema()
	computed := s.Fields["text"]
	computed.Name = "@computed/x"
	s.Fields["@computed/x"] = computed
	for i := 0; i < 2; i++ {
		if _, _, err := compileSQLiteWhere(where, s, SQLiteOptions{}, relations); err != nil {
			t.Fatal(err)
		}
	}
	// Decisions are cached per execution.
	if want := []SQLitePredicate{{Field: "text", Op: "contains", Value: "abc"}}; !reflect.DeepEqual(p.calls, want) {
		t.Fatalf("calls %#v", p.calls)
	}

	// Host failures fail the compilation and are not clause diagnostics.
	failing := &relationProvider{err: errors.New("index offline")}
	_, _, err := compileSQLiteWhere(where[2:], sqliteTestSchema(), SQLiteOptions{}, newSQLiteRelations(context.Background(), nil, failing))
	var relationErr *sqliteRelationError
	if !errors.As(err, &relationErr) || !strings.Contains(err.Error(), "index offline") {
		t.Fatalf("provider error %v", err)
	}
	if _, clause := metricClauseError(context.Background(), err); clause {
		t.Fatal("provider failure isolated as a metric clause")
	}
}

func TestSQLitePredicateRelationValidation(t *testing.T) {
	for sql, args := range map[string][]any{
		"":                                       nil,
		"SELECT id FROM t WHERE a = ?1":          {1},
		"SELECT id FROM t WHERE a = :a":          {1},
		"SELECT id FROM t WHERE a = @a":          {1},
		"SELECT id FROM t WHERE a = $a":          {1},
		"SELECT id FROM t WHERE a = ?":           nil,
		"SELECT id FROM t WHERE a = ? AND b=?":   {1},
		"SELECT id FROM t); DROP TABLE t; --":    nil,
		"SELECT id FROM t -- ?":                  nil,
		"SELECT id FROM t /* ? */":               nil,
		"SELECT id FROM t WHERE (a = 1":          nil,
		"SELECT id FROM t WHERE a = 'x":          nil,
		"SELECT id FROM [t]":                     nil,
		"SELECT id FROM t; SELECT 1":             nil,
		"SELECT id FROM t WHERE a = '?' AND ?=?": {1},
	} {
		if err := validateSQLiteRelation(SQLitePredicateRelation{SQL: sql, Args: args, Exact: true}); err == nil {
			t.Errorf("accepted %q %v", sql, args)
		}
	}
	for sql, args := range map[string][]any{
		"SELECT rowid FROM fts WHERE fts MATCH ?":                     {"\"abc\""},
		"SELECT id FROM t WHERE a = '?:@$;--' AND \"b?\" = ? AND (c)": {1},
	} {
		if err := validateSQLiteRelation(SQLitePredicateRelation{SQL: sql, Args: args}); err != nil {
			t.Errorf("rejected %q: %v", sql, err)
		}
	}
	if err := validateSQLiteRelation(SQLitePredicateRelation{SQL: "SELECT 1", Key: "@computed/x"}); err == nil {
		t.Error("accepted a computed key")
	}
}
