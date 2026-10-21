package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func crossFieldSchema() qt.Schema {
	s := qt.Schema{Name: "cross", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id": {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true},
		"k":  {Name: "k", Kind: qt.FieldText, Expr: "r.k", Sortable: true, ServerFilter: true},
	}}
	for i := 0; i < 9; i++ {
		name := fmt.Sprintf("n%d", i)
		s.Fields[name] = qt.FieldSpec{Name: name, Kind: qt.FieldNumber, Expr: "r." + name, ExpressionNumeric: true, Sortable: true, ServerFilter: true}
	}
	return s
}
func crossFieldDDL(rows int) string {
	columns, values := []string{}, []string{}
	for i := 0; i < 9; i++ {
		columns = append(columns, fmt.Sprintf("n%d", i))
		values = append(values, fmt.Sprintf("(i+%d)%%100", i))
	}
	return fmt.Sprintf(`CREATE TABLE source(id TEXT,k TEXT,tenant TEXT,%s);
 WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
 INSERT INTO source SELECT printf('%%08d',i),CASE WHEN i%%5=0 THEN NULL WHEN i%%7=0 THEN '' ELSE 'g'||(i%%3) END,'allowed',%s FROM nums;
 INSERT INTO source SELECT 'hidden','hidden','denied',%s;`, strings.Join(columns, ","), rows, strings.Join(values, ","), strings.Repeat("999,", 8)+"999")
}
func crossFieldQuery(grouped bool) qt.MetricQuery {
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Limit: 3, Offset: 1, OrderBy: []qt.OrderBy{{Field: "id", Dir: "desc"}}}
	q.Metrics = append(q.Metrics, qt.AggSpec{ID: "count", Op: "count"})
	for i := 0; i < 9; i++ {
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("sum%d", i), Op: "sum", Field: fmt.Sprintf("n%d", i)})
	}
	if grouped {
		for i := range q.Metrics {
			q.Metrics[i].GroupBy = []string{"k"}
		}
	}
	return q
}
func crossFieldDataset(t *testing.T, log *statementLog) (*sql.DB, qt.SQLiteV2Dataset) {
	t.Helper()
	db := hookedDB(t, log, crossFieldDDL(30))
	d := qt.SQLiteV2Dataset{Schema: crossFieldSchema(), SourceSQL: "SELECT * FROM source WHERE tenant=?1", SourceArgs: []any{"allowed"}}
	return db, d
}
func crossFieldParity(t *testing.T, db *sql.DB, d qt.SQLiteV2Dataset, q qt.MetricQuery, o qt.PlanOptions) qt.SQLiteV2ExecutionResult {
	t.Helper()
	want := []qt.SQLiteMetricV2{}
	for _, spec := range q.Metrics {
		single := q
		single.Metrics = []qt.AggSpec{spec}
		r, err := d.ExecuteV2(context.Background(), db, nil, &single, o)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, r.Metrics.Metrics[0])
	}
	got, err := d.ExecuteV2(context.Background(), db, nil, &q, o)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Metrics.Metrics, want) {
		t.Fatalf("batch differs:\ngot %#v\nwant %#v", got.Metrics.Metrics, want)
	}
	return got
}
func TestV2CrossFieldReductions(t *testing.T) {
	for _, grouped := range []bool{false, true} {
		t.Run(fmt.Sprint(grouped), func(t *testing.T) {
			log := &statementLog{}
			db, d := crossFieldDataset(t, log)
			q := crossFieldQuery(grouped)
			crossFieldParity(t, db, d, q, qt.PlanOptions{})
			log.reset(nil)
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			result, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if n := log.count("CREATE TEMP TABLE _qt_reduction_"); n != 1 {
				t.Fatalf("%d reductions, want one shared reduction", n)
			}
			// Population preflight remains separate from the shared reduction. Statement
			// counts describe submitted work, not physical SQLite table scans.
			if n := log.count("SELECT COUNT(*) FROM (SELECT 1"); n != 1 {
				t.Fatalf("%d population checks", n)
			}
			assertNoReductions(t, tx)
			if result.Metrics.Metrics[0].ProcessedRows != 30 {
				t.Fatal(result)
			}
			if grouped {
				result.Metrics.Metrics[1].Buckets[0].Keys[0] = "changed"
				if reflect.DeepEqual(result.Metrics.Metrics[0].Buckets[0].Keys, result.Metrics.Metrics[1].Buckets[0].Keys) {
					t.Fatal("shared keys")
				}
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestV2CrossFieldSemantics(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	for _, mutation := range []string{
		"UPDATE source SET n0=0.1,n1=0.2,n2=NULL WHERE tenant='allowed'",
		"UPDATE source SET n0='invalid',n1=9007199254740992,n2=1e101 WHERE id='00000001'",
		"UPDATE source SET n3=CASE WHEN id='00000001' THEN 9007199254740991 WHEN id='00000002' THEN -9007199254740991 ELSE 0 END WHERE tenant='allowed'",
	} {
		if _, err := db.Exec(mutation); err != nil {
			t.Fatal(err)
		}
	}
	for _, grouped := range []bool{false, true} {
		q := crossFieldQuery(grouped)
		for _, expression := range []string{"AVG([n1])", "MIN([n2])", "MAX([n4])", "COUNT_DISTINCT([n5])", "COUNT([n0])", "IF(COUNT()>0,7,SUM([n0]))", "COALESCE(SUM([n6]),1/0)", "SUM(IF([n7]>5,[n8],0))"} {
			q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("expr%d", len(q.Metrics)), Expression: expression, GroupBy: q.Metrics[0].GroupBy})
		}
		q.Metrics[1].Sort = []qt.MetricSort{{Key: "value", Dir: "desc"}}
		q.Metrics[1].GroupLimit = 1
		if grouped {
			q.Metrics[2].MinCount = 9
		}
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
	// Separate per-metric predicates and scoped windows cannot share populations.
	q := crossFieldQuery(true)
	q.Metrics[1].Where = []qt.WhereTerm{{Field: "id", Op: "!=", Value: "00000001"}}
	q.Metrics[2].Scope = "shownRows"
	q.Metrics[3].Scope = "shownRows"
	q.Where = []qt.WhereTerm{{Field: "id", Op: "!=", Value: "00000002"}}
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
	// Empty populations preserve grouped and scalar COUNT/SUM/AVG semantics.
	q.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "absent"}}
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
	for i := range q.Metrics {
		q.Metrics[i].GroupBy = nil
	}
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
}
func TestV2CrossFieldGuards(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	limited := d
	limited.MaxGroups = 1
	result := crossFieldParity(t, db, limited, q, qt.PlanOptions{})
	for _, m := range result.Metrics.Metrics {
		if m.Error != "group population exceeds host budget" {
			t.Fatal(m)
		}
	}
	limited = d
	limited.MaxPopulation = 2
	log.reset(nil)
	if _, err := limited.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err == nil || log.count("CREATE TEMP TABLE") != 0 {
		t.Fatal("population guard", err)
	}
	q.ExpectedRevisions = map[string]string{"hidden": "1"}
	log.reset(nil)
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: "hidden", Revision: "2"}, nil
	})}
	if _, err := d.ExecuteV2(context.Background(), db, nil, &q, o); err == nil || log.count("CREATE TEMP TABLE") != 0 {
		t.Fatal("revision guard", err)
	}
	q.ExpectedRevisions = nil
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	log.reset(func(query string) error {
		if strings.Contains(query, "CREATE TEMP TABLE _qt_reduction_") {
			cancel()
		}
		return nil
	})
	if _, err := d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation", err)
	}
	assertNoReductions(t, tx)
}
func TestV2CrossFieldStatementFailureIsolation(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	// Fail only the combination: each individual plan still executes normally.
	attempts := 0
	log.reset(func(query string) error {
		if strings.Contains(query, "CREATE TEMP TABLE _qt_reduction_") {
			attempts++
			return errors.New("combined failure")
		}
		return nil
	})
	result, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range result.Metrics.Metrics {
		if m.Error != "" {
			t.Fatal(m)
		}
	}
	if attempts != 2 {
		t.Fatalf("wanted failed integer and general combinations, got %d attempts", attempts)
	}
}

func TestV2CrossFieldSourceEvaluation(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	d.SourceSQL = "SELECT *,qt_test_metric_probe(k) AS sampled_key FROM source WHERE tenant=?1"
	f := d.Schema.Fields["k"]
	f.Expr = "r.sampled_key"
	d.Schema.Fields["k"] = f
	q := crossFieldQuery(true)
	// Compare with a single compiler-owned multi-input reduction. This counts
	// key-expression evaluations, not physical table scans. The population check
	// projects 1 and does not consume sampled_key.
	single := q
	terms := []string{}
	for i := 0; i < 9; i++ {
		terms = append(terms, fmt.Sprintf("SUM([n%d])", i))
	}
	single.Metrics = []qt.AggSpec{{ID: "all", Expression: strings.Join(terms, "+"), GroupBy: []string{"k"}}}
	metricProbeCalls.Store(0)
	if _, err := d.ExecuteV2(context.Background(), db, nil, &single, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	expected := metricProbeCalls.Load()
	metricProbeCalls.Store(0)
	if _, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if actual := metricProbeCalls.Load(); actual > expected || actual != 30 {
		t.Fatalf("key evaluations: batch=%d, one combined reduction=%d", actual, expected)
	}
}

func TestV2CrossFieldIntegerDomains(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	for _, expression := range []string{"AVG([n0])", "MIN([n1])", "MAX([n2])", "COUNT_DISTINCT([n3])", "COUNT([n4])"} {
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("expr%d", len(q.Metrics)), Expression: expression, GroupBy: []string{"k"}})
	}
	for _, sql := range []string{
		"UPDATE source SET n0=NULL,n4=NULL WHERE id='00000001'",
		"UPDATE source SET n0=9007199254740991,n1=-9007199254740991 WHERE id='00000001'",
		"UPDATE source SET n0=-9007199254740991,n1=9007199254740991 WHERE id='00000004'",
		"UPDATE source SET n0=-9223372036854775808 WHERE id='00000002'",
		"UPDATE source SET n0=0.1,n1=0.2 WHERE id='00000002'",
		"UPDATE source SET n0=X'3132',k=42 WHERE id='00000002'",
	} {
		if _, err := db.Exec(sql); err != nil {
			t.Fatal(err)
		}
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
	// A physical table with the internal CTE's preferred name must not be shadowed.
	if _, err := db.Exec("CREATE TABLE qt_integer_input AS SELECT * FROM source"); err != nil {
		t.Fatal(err)
	}
	d.SourceSQL = "SELECT * FROM qt_integer_input WHERE tenant=?1"
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
}

func TestV2CrossFieldCollationAndComputed(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	if _, err := db.Exec("UPDATE source SET k=CASE WHEN id<'00000015' THEN 'a' ELSE 'A' END"); err != nil {
		t.Fatal(err)
	}
	f := d.Schema.Fields["k"]
	f.Expr = "r.k COLLATE NOCASE"
	d.Schema.Fields["k"] = f
	q := crossFieldQuery(true)
	result := crossFieldParity(t, db, d, q, qt.PlanOptions{})
	if result.Metrics.Metrics[0].GroupCount != 2 {
		t.Fatal("inherited collation merged keys", result)
	}
	q.ExpectedRevisions = map[string]string{"twice": "1"}
	q.Metrics = append(q.Metrics, qt.AggSpec{ID: "computed", Expression: "SUM([@computed/twice])", GroupBy: []string{"k"}})
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: "twice", Label: "Twice", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "IF([n0]>5,[n1]*2,0)"}}, nil
	})}
	crossFieldParity(t, db, d, q, o)
}

func TestV2CrossFieldCompilerBudgetFallback(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	q.Metrics = nil
	for i := 0; i < 8; i++ {
		terms := []string{}
		for j := 1; j <= 25; j++ {
			terms = append(terms, fmt.Sprintf("[n%d]*%d", i, i*100+j))
		}
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("wide%d", i), Expression: "SUM(" + strings.Join(terms, "+") + ")", GroupBy: []string{"k"}})
	}
	result := crossFieldParity(t, db, d, q, qt.PlanOptions{})
	for _, m := range result.Metrics.Metrics {
		if m.Error != "" {
			t.Fatal(m)
		}
	}
}

func TestV2CrossFieldCleanupFailure(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	sentinel := errors.New("injected V2 cleanup failure")
	log.reset(func(query string) error {
		if strings.HasPrefix(query, "DROP TABLE IF EXISTS _qt_reduction_") {
			return sentinel
		}
		return nil
	})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	out, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
	if !errors.Is(err, sentinel) || out.Metrics != nil {
		t.Fatalf("cleanup failure returned a result: %#v %v", out, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	log.reset(nil)
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	assertNoReductions(t, tx)
}

func TestV2CrossFieldStoredAndOpaqueSources(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	check := func(wantMaterialized bool) {
		t.Helper()
		log.reset(nil)
		metricProbeCalls.Store(0)
		if _, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
			t.Fatal(err)
		}
		var reduction string
		for _, sql := range log.seen {
			if strings.HasPrefix(sql, "CREATE TEMP TABLE _qt_reduction_") {
				reduction = sql
				break
			}
		}
		if reduction == "" {
			t.Fatal("missing reduction")
		}
		direct := strings.Contains(reduction, " AS NOT MATERIALIZED (")
		if direct == wantMaterialized {
			t.Fatalf("stored-source choice: direct=%t, want materialized=%t", direct, wantMaterialized)
		}
	}
	check(false)
	// Resolving a view must expose hidden functions to the planner. EXPLAIN
	// itself must not execute them, and the chosen projection evaluates them once.
	if _, err := db.Exec(`CREATE VIEW opaque_source AS SELECT id,k,tenant,qt_test_metric_probe(n0) AS n0,n1,n2,n3,n4,n5,n6,n7,n8 FROM source`); err != nil {
		t.Fatal(err)
	}
	d.SourceSQL = "SELECT * FROM opaque_source WHERE tenant=?1"
	check(true)
	if n := metricProbeCalls.Load(); n != 30 {
		t.Fatalf("opaque view evaluated %d inputs, want 30", n)
	}
	// A correlated scalar subquery also keeps materialization, even without a UDF.
	d.SourceSQL = "SELECT id,k,tenant,(SELECT n0) AS n0,n1,n2,n3,n4,n5,n6,n7,n8 FROM source WHERE tenant=?1"
	check(true)
	// Ordinary indexes and comparisons retain the direct option.
	d.SourceSQL = "SELECT * FROM source WHERE tenant=?1"
	if _, err := db.Exec("CREATE INDEX source_tenant ON source(tenant)"); err != nil {
		t.Fatal(err)
	}
	q.Where = []qt.WhereTerm{{Field: "n0", Op: ">", Value: "3"}}
	check(false)
}

func TestV2CrossFieldProofStorageAndKeyTypes(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	for _, value := range []string{"'12'", "'0'", "X'3132'", "NULL", "-3", "9223372036854775807"} {
		if _, err := db.Exec("UPDATE source SET n0=" + value + " WHERE id='00000001'"); err != nil {
			t.Fatal(err)
		}
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
	// An INTEGER and a REAL boolean compare equal in SQLite GROUP BY. Validating
	// only the representative would miss whichever member had invalid storage.
	f := d.Schema.Fields["k"]
	f.Kind = qt.FieldBool
	f.Expr = "CASE WHEN r.id<'00000015' THEN 1 ELSE 1.0 END"
	d.Schema.Fields["k"] = f
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
	// Text groups can validate once per exact BINARY value, but storage types
	// and malformed UTF-8 must still force the ordinary error-sidecar path.
	f.Kind = qt.FieldText
	for _, expr := range []string{"CASE WHEN r.id<'00000015' THEN 1 ELSE '1' END", "CAST(X'FF' AS TEXT)", "X'3132'"} {
		f.Expr = expr
		d.Schema.Fields["k"] = f
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
}

func TestV2CrossFieldSourceInspectionFallback(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := crossFieldQuery(true)
	log.reset(func(sql string) error {
		if strings.HasPrefix(sql, "EXPLAIN ") {
			return errors.New("inspection unavailable")
		}
		return nil
	})
	result, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range result.Metrics.Metrics {
		if m.Error != "" {
			t.Fatal(m)
		}
	}
	if n := log.count("CREATE TEMP TABLE _qt_reduction_"); n != 1 {
		t.Fatalf("fallback created %d reductions", n)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log.reset(func(sql string) error {
		if strings.HasPrefix(sql, "EXPLAIN ") {
			cancel()
		}
		return nil
	})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal("inspection cancellation", err)
	}
	assertNoReductions(t, tx)
}
