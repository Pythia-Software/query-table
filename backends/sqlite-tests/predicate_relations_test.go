package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A toy model of a host's transactionally maintained trigram index (Pharos's
// query_text_index.go): an FTS5 trigram table over Go-lowercased bodies,
// keyed by the source's integer seq, plus a backfill cursor and readiness flag
// in meta. A quoted MATCH phrase answers ASCII substring needles of three or
// more bytes exactly; other needles and operators keep the typed predicate.

type trigramMode int

const (
	trigramExact     trigramMode = iota // exact once ready; incomplete: candidate
	trigramCandidate                    // always a candidate (complete or not)
	trigramDecline                      // exact once ready; incomplete: decline
)

type trigramRelations struct {
	mode  trigramMode
	calls int
	used  int
}

func (r *trigramRelations) PredicateRelation(ctx context.Context, tx *sql.Tx, p qt.SQLitePredicate) (qt.SQLitePredicateRelation, bool, error) {
	r.calls++
	if p.Field != "command" || p.Op != "contains" || len(p.Value) < 3 {
		return qt.SQLitePredicateRelation{}, false, nil
	}
	for _, c := range p.Value {
		if c > 127 || c == 0 {
			return qt.SQLitePredicateRelation{}, false, nil
		}
	}
	// Readiness is read in the execution's own transaction and snapshot.
	var ready string
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT value FROM meta WHERE key='calls_fts_ready'),'')").Scan(&ready); err != nil {
		return qt.SQLitePredicateRelation{}, false, err
	}
	phrase := `"` + strings.ReplaceAll(strings.ToLower(p.Value), `"`, `""`) + `"`
	match := "SELECT rowid FROM calls_fts WHERE calls_fts MATCH ?"
	relation := qt.SQLitePredicateRelation{SQL: match, Args: []any{phrase}, Key: "seq"}
	switch {
	case ready == "1":
		relation.Exact = r.mode != trigramCandidate
	case r.mode == trigramDecline:
		return qt.SQLitePredicateRelation{}, false, nil
	default:
		// Incomplete backfill: indexed matches plus every unindexed row is a
		// superset of the predicate's rows, so it can only narrow.
		relation.SQL = match + " UNION ALL SELECT seq FROM calls WHERE seq > (SELECT CAST(value AS INTEGER) FROM meta WHERE key='calls_fts_cursor')"
	}
	r.used++
	return relation, true, nil
}

var trigramBodies = []any{
	"A TEST\nwith \"quotes\" \u212aELVIN \u0130", "  ", "a", "", nil, "go test ./...", "GO TEST ./pkg", "git status",
	"echo foo bar", "foobar", "test", "TeSt quotes", "\"quoted\"", "with\nwide newline", "   three", "caf\u00e9 test",
}

func openTrigram(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "trigram.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, statement := range []string{
		`CREATE TABLE calls(id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, provider TEXT, command TEXT, tokens INTEGER)`,
		`CREATE VIRTUAL TABLE calls_fts USING fts5(body, tokenize='trigram case_sensitive 1', content='')`,
		`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 64; i++ {
		body := trigramBodies[i%len(trigramBodies)]
		if i >= len(trigramBodies) && body != nil {
			body = fmt.Sprintf("%s #%d", body, i)
		}
		provider := []any{"codex", "claude", nil}[i%3]
		if _, err := db.Exec(`INSERT INTO calls VALUES(?,?,?,?,?)`, fmt.Sprintf("c%02d", i), i+1, provider, body, i%7); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

// backfill indexes nonempty bodies up to seq <= through; all of them when
// through is negative. Readiness is set only once every row is indexed.
func backfill(t *testing.T, db *sql.DB, through int) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var last int
	if err := tx.QueryRow(`SELECT MAX(seq) FROM calls`).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if through < 0 || through > last {
		through = last
	}
	if _, err := tx.Exec(`DELETE FROM calls_fts`); err != nil {
		if _, err = tx.Exec(`INSERT INTO calls_fts(calls_fts) VALUES('delete-all')`); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := tx.Query(`SELECT seq, command FROM calls WHERE seq <= ? AND command IS NOT NULL AND command <> ''`, through)
	if err != nil {
		t.Fatal(err)
	}
	type entry struct {
		seq  int
		body string
	}
	entries := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.seq, &e.body); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, e)
	}
	rows.Close()
	for _, e := range entries {
		if _, err := tx.Exec(`INSERT INTO calls_fts(rowid, body) VALUES(?, ?)`, e.seq, strings.ToLower(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	ready := "0"
	if through == last {
		ready = "1"
	}
	for key, value := range map[string]string{"calls_fts_cursor": fmt.Sprint(through), "calls_fts_ready": ready} {
		if _, err := tx.Exec(`INSERT OR REPLACE INTO meta VALUES(?,?)`, key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func trigramSchema() qt.Schema {
	yes := true
	return qt.Schema{Name: "calls", IDField: "id", DefaultSort: []qt.OrderBy{{Field: "id", Dir: "asc"}}, Fields: map[string]qt.FieldSpec{
		"id":       {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true},
		"seq":      {Name: "seq", Kind: qt.FieldNumber, Expr: "r.seq", Sortable: true, ServerFilter: true, ExpressionNumeric: true},
		"provider": {Name: "provider", Kind: qt.FieldEnum, Expr: "r.provider", Sortable: true, ServerFilter: true, Groupable: &yes},
		"command":  {Name: "command", Kind: qt.FieldText, Expr: "r.command", Sortable: true, ServerFilter: true, Groupable: &yes},
		"tokens":   {Name: "tokens", Kind: qt.FieldNumber, Expr: "r.tokens", Sortable: true, ServerFilter: true, ExpressionNumeric: true},
	}}
}

// trigramPaths runs one filter through every SQLite execution path and
// returns a canonical JSON transcript of the results.
func trigramPaths(t *testing.T, db *sql.DB, relations qt.SQLitePredicateRelations, where []qt.WhereTerm) string {
	t.Helper()
	ctx := context.Background()
	schema := trigramSchema()
	out := map[string]any{}
	record := func(name string, value any, err error) {
		if err != nil {
			t.Fatalf("%s %s: %v", name, mustJSON(t, where), err)
		}
		out[name] = value
	}

	v1 := qt.SQLiteDataset{Schema: schema, FromSQL: "FROM calls r", PredicateRelations: relations}
	rows, err := v1.Rows(ctx, db, qt.WireQuery{Select: []string{"id"}, Where: where, Limit: 1000})
	record("v1 rows", rows, err)
	aggregations, err := v1.Aggregations(ctx, db, qt.SQLiteAggregationRequest{Where: where, Aggregations: []qt.AggSpec{{ID: "n", Op: "count", GroupBy: []string{"provider"}}}})
	record("v1 aggregations", aggregations, err)

	v2 := qt.SQLiteV2Dataset{Schema: schema, SourceSQL: "SELECT * FROM calls", Scope: "s", Dataset: "calls", PredicateRelations: relations}
	rowQuery := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id", "command"}, Where: where, Limit: 1000}}
	v2Rows, err := v2.ExecuteV2(ctx, db, &rowQuery, nil, qt.PlanOptions{})
	record("v2 rows", v2Rows, err)
	population, err := v2.ExecuteV2(ctx, db, nil, &qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Where: where, Metrics: []qt.AggSpec{
		{ID: "n", Op: "count"},
		{ID: "tokens", Op: "sum", Field: "tokens", GroupBy: []string{"provider"}},
	}}, qt.PlanOptions{})
	record("v2 population metrics", population, err)
	scoped, err := v2.ExecuteV2(ctx, db, nil, &qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{
		{ID: "all", Op: "count"},
		{ID: "filtered", Op: "count", GroupBy: []string{"provider"}, Where: where},
	}}, qt.PlanOptions{})
	record("v2 metric filters", scoped, err)

	v3 := qt.QueryDatasetV3{Schema: schema, SourceSQL: "SELECT * FROM calls", Dialect: "sqlite", Scope: "s", Dataset: "calls", PredicateRelations: relations}
	v3Query := func(q qt.QueryRequestV3) qt.QueryResultV3 {
		q.Version, q.Profile = 3, qt.SQLiteExpressionProfile
		result, err := v3.Execute(ctx, db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatalf("v3 %s: %v", mustJSON(t, where), err)
		}
		return result
	}
	out["v3 rows"] = v3Query(qt.QueryRequestV3{Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: where, Limit: 1000},
		Metrics: []qt.AggSpec{{ID: "n", Op: "count", GroupBy: []string{"provider"}}}})
	grouping := &qt.GroupingDefinition{Keys: []string{"provider"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total_tokens", Op: "sum", Field: "tokens"}}}
	out["v3 grouped source"] = v3Query(qt.QueryRequestV3{Rows: true, Source: qt.WireQuery{Where: where}, Grouping: grouping,
		Result: qt.WireQuery{Select: []string{"provider", "num", "total_tokens"}, Limit: 1000}})
	// Group filters over grouped rows compare group values, never source keys.
	for _, term := range where {
		for _, p := range term.Predicates() {
			if p.Field != "command" {
				return planFingerprint.ReplaceAllString(mustJSON(t, out), `"fingerprint":""`)
			}
		}
	}
	out["v3 group filter"] = v3Query(qt.QueryRequestV3{Rows: true, Grouping: &qt.GroupingDefinition{Keys: []string{"command"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}}},
		Result: qt.WireQuery{Select: []string{"command", "num"}, Where: where, Limit: 1000}})
	// A plan fingerprint identifies the compiled SQL, which a relation changes.
	return planFingerprint.ReplaceAllString(mustJSON(t, out), `"fingerprint":""`)
}

var planFingerprint = regexp.MustCompile(`"fingerprint":"[0-9a-f]*"`)

func trigramCases() map[string][]qt.WhereTerm {
	cases := map[string][]qt.WhereTerm{}
	needles := []string{"TEST", "test", "foo", "quotes", "kelvin", "a", "absent_82f14c", "\"qu", "  ", "\nwi", "   ", "\u0130", "caf\u00e9", "go test ./"}
	for _, needle := range needles {
		for _, negated := range []bool{false, true} {
			cases[fmt.Sprintf("contains %q negated=%v", needle, negated)] = []qt.WhereTerm{{Field: "command", Op: "contains", Value: needle, Negated: negated}}
		}
	}
	for _, op := range []string{"starts_with", "ends_with", "=", "!=", "matches_regex"} {
		value := "test"
		if op == "matches_regex" {
			value = "te?st"
		}
		cases["unsupported "+op] = []qt.WhereTerm{{Field: "command", Op: op, Value: value}}
		cases["unsupported negated "+op] = []qt.WhereTerm{{Field: "command", Op: op, Value: value, Negated: true}}
	}
	contains := func(v string, negated bool) qt.WhereClause {
		return qt.WhereClause{Field: "command", Op: "contains", Value: v, Negated: negated}
	}
	codex := qt.WhereClause{Field: "provider", Op: "=", Value: "codex"}
	cases["OR of indexed"] = []qt.WhereTerm{{Any: []qt.WhereClause{contains("test", false), contains("foo", false)}}}
	cases["OR with negated indexed"] = []qt.WhereTerm{{Any: []qt.WhereClause{contains("test", true), contains("quotes", false)}}}
	cases["OR with a short needle"] = []qt.WhereTerm{{Any: []qt.WhereClause{contains("test", false), contains("a", false)}}}
	cases["OR with another field"] = []qt.WhereTerm{{Any: []qt.WhereClause{contains("test", false), codex}}}
	cases["OR of ANDs"] = []qt.WhereTerm{{Any: []qt.WhereClause{
		{All: []qt.WhereClause{codex, contains("test", false)}},
		{All: []qt.WhereClause{{Field: "provider", Op: "=", Value: "claude"}, contains("foo", true)}},
	}}}
	cases["OR of ANDs with an uncovered branch"] = []qt.WhereTerm{{Any: []qt.WhereClause{
		{All: []qt.WhereClause{codex, contains("test", false)}},
		{All: []qt.WhereClause{{Field: "tokens", Op: ">", Value: "4"}}},
	}}}
	cases["AND of indexed and typed"] = []qt.WhereTerm{{Field: "command", Op: "contains", Value: "quotes"}, {Field: "tokens", Op: "<", Value: "5"}, {Field: "command", Op: "contains", Value: "foo", Negated: true}}
	return cases
}

func TestPredicateRelationsMatchOrdinaryExecution(t *testing.T) {
	db := openTrigram(t)
	cases := trigramCases()
	for _, state := range []struct {
		name    string
		through int
	}{{"complete index", -1}, {"incomplete backfill", 20}} {
		backfill(t, db, state.through)
		for _, mode := range []struct {
			name string
			mode trigramMode
		}{{"exact", trigramExact}, {"candidate", trigramCandidate}, {"decline", trigramDecline}} {
			used := 0
			for name, where := range cases {
				want := trigramPaths(t, db, nil, where)
				relations := &trigramRelations{mode: mode.mode}
				got := trigramPaths(t, db, relations, where)
				if got != want {
					t.Fatalf("%s/%s/%s:\n got %s\nwant %s", state.name, mode.name, name, got, want)
				}
				used += relations.used
			}
			if expectUsed := !(state.through >= 0 && mode.mode == trigramDecline); (used > 0) != expectUsed {
				t.Fatalf("%s/%s: relations used %d times", state.name, mode.name, used)
			}
		}
	}
}

// A relation is applied, not merely consulted: an exact relation that lies
// replaces the typed check on every path, while a lying candidate (here a
// superset of every row) only narrows and so changes nothing.
func TestPredicateRelationsReplaceOnlyWhenExact(t *testing.T) {
	db := openTrigram(t)
	backfill(t, db, -1)
	lie := func(exact bool, sqlText string) qt.SQLitePredicateRelationsFunc {
		return func(_ context.Context, _ *sql.Tx, p qt.SQLitePredicate) (qt.SQLitePredicateRelation, bool, error) {
			if p.Field != "command" || p.Op != "contains" {
				return qt.SQLitePredicateRelation{}, false, nil
			}
			return qt.SQLitePredicateRelation{SQL: sqlText, Exact: exact}, true, nil
		}
	}
	where := []qt.WhereTerm{{Field: "command", Op: "contains", Value: "absent_82f14c"}}
	want := trigramPaths(t, db, nil, where)
	if got := trigramPaths(t, db, lie(false, "SELECT id FROM calls"), where); got != want {
		t.Fatalf("candidate superset changed results:\n got %s\nwant %s", got, want)
	}
	paths := func(text string) map[string]string {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(text), &raw); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for name, value := range raw {
			out[name] = string(value)
		}
		return out
	}
	liar := lie(true, "SELECT id FROM calls WHERE id = 'c05'")
	lied, plain := paths(trigramPaths(t, db, liar, where)), paths(want)
	for name := range plain {
		if name == "v3 group filter" {
			continue
		}
		if lied[name] == plain[name] || !strings.Contains(lied[name], "1") {
			t.Errorf("%s ignored the exact relation: %s", name, lied[name])
		}
	}
	// Group filters compare group values; a source relation never applies.
	matching := []qt.WhereTerm{{Field: "command", Op: "contains", Value: "test"}}
	grouped, typed := paths(trigramPaths(t, db, liar, matching))["v3 group filter"], paths(trigramPaths(t, db, nil, matching))["v3 group filter"]
	if grouped != typed || !strings.Contains(typed, "go test") {
		t.Fatalf("group filter used a source relation:\n got %s\nwant %s", grouped, typed)
	}
	// Negation of the lying exact relation keeps the compiler's null/empty guard.
	negated := []qt.WhereTerm{{Field: "command", Op: "contains", Value: "absent_82f14c", Negated: true}}
	v2 := qt.SQLiteV2Dataset{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", PredicateRelations: lie(true, "SELECT id FROM calls WHERE id = 'c05'")}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id", "command"}, Where: negated, Limit: 1000}}
	result, err := v2.ExecuteV2(context.Background(), db, &q, nil, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range result.Rows.Rows {
		if row["id"] == "c05" || row["command"] == nil || row["command"] == "" {
			t.Fatalf("negated exact relation row %v", row)
		}
	}
	var nonempty int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM calls WHERE command IS NOT NULL AND command <> ''`).Scan(&nonempty); err != nil {
		t.Fatal(err)
	}
	if result.Rows.Total != nonempty-1 {
		t.Fatalf("negated total %d, want %d", result.Rows.Total, nonempty-1)
	}
}

// Relations run inside the caller's transaction, so they see its writes and
// its snapshot, exactly like the typed predicate over the same rows.
func TestPredicateRelationsUseTheExecutionTransaction(t *testing.T) {
	db := openTrigram(t)
	backfill(t, db, -1)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO calls VALUES('new',1000,'codex','Fresh NEEDLE_77 row',1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO calls_fts(rowid, body) VALUES(1000,'fresh needle_77 row')`); err != nil {
		t.Fatal(err)
	}
	relations := &trigramRelations{mode: trigramExact}
	where := []qt.WhereTerm{{Field: "command", Op: "contains", Value: "needle_77"}}
	q := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"id"}, Where: where, Limit: 10}}
	for _, provider := range []qt.SQLitePredicateRelations{nil, relations} {
		d := qt.SQLiteV2Dataset{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", PredicateRelations: provider}
		result, err := d.ExecuteV2In(ctx, tx, &q, nil, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if result.Rows.Total != 1 || result.Rows.Rows[0]["id"] != "new" {
			t.Fatalf("provider %v: %+v", provider != nil, result.Rows)
		}
	}
	if relations.used != 1 {
		t.Fatalf("relation used %d times", relations.used)
	}
	// Another connection's snapshot does not see the uncommitted row.
	d := qt.SQLiteV2Dataset{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", PredicateRelations: relations}
	outside, err := d.ExecuteV2(ctx, db, &q, nil, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if outside.Rows.Total != 0 {
		t.Fatalf("outside snapshot saw %+v", outside.Rows)
	}
}

func TestPredicateRelationErrorsFailTheExecution(t *testing.T) {
	db := openTrigram(t)
	backfill(t, db, -1)
	failing := qt.SQLitePredicateRelationsFunc(func(context.Context, *sql.Tx, qt.SQLitePredicate) (qt.SQLitePredicateRelation, bool, error) {
		return qt.SQLitePredicateRelation{}, false, fmt.Errorf("index unavailable")
	})
	bad := qt.SQLitePredicateRelationsFunc(func(context.Context, *sql.Tx, qt.SQLitePredicate) (qt.SQLitePredicateRelation, bool, error) {
		return qt.SQLitePredicateRelation{SQL: "SELECT rowid FROM calls_fts WHERE calls_fts MATCH ?1", Args: []any{"x"}, Key: "seq", Exact: true}, true, nil
	})
	where := []qt.WhereTerm{{Field: "command", Op: "contains", Value: "test"}}
	for _, provider := range []qt.SQLitePredicateRelations{failing, bad} {
		v2 := qt.SQLiteV2Dataset{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", PredicateRelations: provider}
		// A metric-only filter would otherwise be isolated as a metric error.
		_, err := v2.ExecuteV2(context.Background(), db, nil, &qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{{ID: "n", Op: "count", Where: where}}}, qt.PlanOptions{})
		if err == nil || !strings.Contains(err.Error(), "predicate relation") {
			t.Fatalf("metric filter: %v", err)
		}
		v3 := qt.QueryDatasetV3{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", Dialect: "sqlite", PredicateRelations: provider}
		_, err = v3.Execute(context.Background(), db, qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: where, Limit: 10}}, qt.PlanOptions{})
		if err == nil || !strings.Contains(err.Error(), "predicate relation") {
			t.Fatalf("v3: %v", err)
		}
	}
	postgres := qt.QueryDatasetV3{Schema: trigramSchema(), SourceSQL: "SELECT * FROM calls", Dialect: "postgres", PredicateRelations: failing}
	if _, err := postgres.Execute(context.Background(), db, qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Limit: 10}}, qt.PlanOptions{}); err == nil {
		t.Fatal("postgres dataset accepted predicate relations")
	}
}
