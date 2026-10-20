package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// statementHookConnector observes, and can fail, every statement the executor
// sends. Tests use it to count executions without timing anything.
type statementHookConnector struct {
	base driver.Driver
	dsn  string
	hook func(string) error
}

func (c statementHookConnector) Driver() driver.Driver { return c.base }
func (c statementHookConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return statementHookConn{Conn: conn, ConnBeginTx: conn.(driver.ConnBeginTx), hook: c.hook}, nil
}

type statementHookConn struct {
	driver.Conn
	driver.ConnBeginTx
	hook func(string) error
}

func (c statementHookConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := c.hook(query); err != nil {
		return nil, err
	}
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}
func (c statementHookConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if err := c.hook(query); err != nil {
		return nil, err
	}
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

type statementLog struct {
	mu   sync.Mutex
	seen []string
	fail func(string) error
}

func (l *statementLog) hook(query string) error {
	l.mu.Lock()
	l.seen = append(l.seen, query)
	fail := l.fail
	l.mu.Unlock()
	if fail != nil {
		return fail(query)
	}
	return nil
}
func (l *statementLog) reset(fail func(string) error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seen, l.fail = nil, fail
}
func (l *statementLog) count(marker string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, query := range l.seen {
		if strings.Contains(query, marker) {
			n++
		}
	}
	return n
}

// hookedV3 opens a one-connection file database whose statements pass
// through log. The schema mirrors setupV3 over a dedicated table.
func hookedV3(t *testing.T, log *statementLog, rows string) (*sql.DB, qt.QueryDatasetV3) {
	t.Helper()
	original, _ := setupV3(t)
	dsn := filepath.ToSlash(filepath.Join(t.TempDir(), "hooked.db"))
	db := sql.OpenDB(statementHookConnector{base: original.Driver(), dsn: dsn, hook: log.hook})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec("CREATE TABLE source(id TEXT,k TEXT,n REAL,at TEXT,label TEXT); INSERT INTO source VALUES " + rows); err != nil {
		t.Fatal(err)
	}
	_, d := setupV3(t)
	d.SourceSQL = "SELECT * FROM source"
	return db, d
}

func tempTables(t *testing.T, tx *sql.Tx) int {
	t.Helper()
	var n int
	if err := tx.QueryRow("SELECT COUNT(*) FROM sqlite_temp_master WHERE type='table' AND name LIKE 'qt_v3_%'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func representativeRequest(order ...qt.OrderBy) qt.QueryRequestV3 {
	q := groupedRequest()
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{
		{ID: "num", Op: "count"},
		{ID: "row_id", Op: "row", Field: "id"},
		{ID: "row_n", Op: "row", Field: "n"},
		{ID: "row_at", Op: "row", Field: "at"},
		{ID: "row_label", Op: "row", Field: "label"},
	}, Representative: &qt.RepresentativeRow{OrderBy: order}}
	q.Result = qt.WireQuery{Select: []string{"k", "num", "row_id", "row_n", "row_at", "row_label"}, OrderBy: qt.OrderBys{{Field: "k", Dir: "asc", Nulls: "last"}}, Limit: 10}
	return q
}

// Ties on n, NULL orderings, NULL ROW values and a NULL group key.
const representativeRows = `('1','a',5,'2026-01-01T00:00:00.000Z','one'),('2','a',5,NULL,NULL),('3','a',NULL,'2026-01-03T00:00:00.000Z','three'),
('4','b',7,'2026-01-04T00:00:00.000Z','four'),
('5',NULL,1,'2026-01-05T00:00:00.000Z','five'),('6',NULL,1,NULL,'six')`

func TestV3RepresentativeRowsShareOneRanking(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, representativeRows)
	source := map[string][]any{}
	for _, row := range [][]any{
		{"1", float64(5), "2026-01-01T00:00:00.000Z", "one"}, {"2", float64(5), nil, nil}, {"3", nil, "2026-01-03T00:00:00.000Z", "three"},
		{"4", float64(7), "2026-01-04T00:00:00.000Z", "four"}, {"5", float64(1), "2026-01-05T00:00:00.000Z", "five"}, {"6", float64(1), nil, "six"},
	} {
		source[row[0].(string)] = row[1:]
	}
	for _, c := range []struct {
		name  string
		order []qt.OrderBy
		want  map[any]string // group key -> chosen source ID
	}{
		// Equal n values fall back to the source ID, descending.
		{"tie", []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: "last"}}, map[any]string{"a": "2", "b": "4", nil: "6"}},
		{"nulls first", []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: "first"}}, map[any]string{"a": "3", "b": "4", nil: "6"}},
		{"explicit id", []qt.OrderBy{{Field: "n", Dir: "asc", Nulls: "last"}, {Field: "id", Dir: "asc"}}, map[any]string{"a": "1", "b": "4", nil: "5"}},
		{"datetime", []qt.OrderBy{{Field: "at", Dir: "asc", Nulls: "last"}}, map[any]string{"a": "1", "b": "4", nil: "5"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			log.reset(nil)
			out, err := d.Execute(context.Background(), db, representativeRequest(c.order...), qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if len(out.Rows) != len(c.want) {
				t.Fatal(out.Rows)
			}
			for _, row := range out.Rows {
				id := c.want[row["k"]]
				if row["row_id"] != id {
					t.Fatalf("group %v chose %v, want %s", row["k"], row["row_id"], id)
				}
				// Every ROW field comes from that one record, NULLs included.
				if got := []any{row["row_n"], row["row_at"], row["row_label"]}; !reflect.DeepEqual(got, source[id]) {
					t.Fatalf("group %v mixed rows: got %#v want %#v", row["k"], got, source[id])
				}
			}
			// One ranking feeds both identity validation and the ROW update.
			if n := log.count("qt_rank"); n != 1 {
				t.Fatalf("representative plan evaluated %d times", n)
			}
		})
	}
}

func TestV3RepresentativeGroupErrorsAndNullKeysStayDistinct(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, `('null-1',NULL,NULL,NULL,'null one'),('null-2',NULL,NULL,NULL,'null two'),('zero-1',NULL,0,NULL,'zero one'),('zero-2',NULL,0,NULL,'zero two'),('two',NULL,2,NULL,'two')`)
	d.ComputedGroupable = map[string]bool{"inv": true}
	q := representativeRequest(qt.OrderBy{Field: "id", Dir: "asc"})
	q.ExpectedRevisions = map[string]string{"inv": "1"}
	q.Grouping.Keys = []string{"@computed/inv"}
	q.Result = qt.WireQuery{Select: []string{"@computed/inv", "num", "row_id", "row_label"}, Limit: 10}
	options := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Inverse", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1/[n]"}}, nil
	})}
	out, err := d.Execute(context.Background(), db, q, options)
	if err != nil {
		t.Fatal(err)
	}
	chosen := map[string]string{}
	for _, row := range out.Rows {
		chosen[row["row_id"].(string)] = row["row_label"].(string)
		switch row["row_id"] {
		case "null-1":
			if row["@computed/inv"] != nil {
				t.Fatal(row)
			}
		case "zero-1":
			if !reflect.DeepEqual(row["@computed/inv"], map[string]any{"computedError": "divide_by_zero"}) {
				t.Fatal(row)
			}
		case "two":
			if row["@computed/inv"] != float64(.5) {
				t.Fatal(row)
			}
		default:
			t.Fatalf("unexpected representative: %#v", row)
		}
	}
	if want := map[string]string{"null-1": "null one", "zero-1": "zero one", "two": "two"}; !reflect.DeepEqual(chosen, want) {
		t.Fatalf("error and NULL partitions merged: %#v", chosen)
	}
}

func TestV3RepresentativeValidationAndCleanup(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, representativeRows)
	run := func(t *testing.T, ctx context.Context, q qt.QueryRequestV3) error {
		t.Helper()
		tx, err := db.BeginTx(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		_, err = d.ExecuteIn(ctx, tx, q, qt.PlanOptions{})
		// The caller's transaction outlives the request; nothing may remain in it.
		if n := tempTables(t, tx); n != 0 {
			t.Fatalf("%d temporary tables leaked (err=%v)", n, err)
		}
		return err
	}
	q := representativeRequest(qt.OrderBy{Field: "n", Dir: "desc", Nulls: "last"})
	t.Run("success", func(t *testing.T) {
		log.reset(nil)
		if err := run(t, context.Background(), q); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("database failure", func(t *testing.T) {
		injected := errors.New("injected representative failure")
		log.reset(func(query string) error {
			if strings.Contains(query, "qt_identity_count>1") {
				return injected
			}
			return nil
		})
		if err := run(t, context.Background(), q); !errors.Is(err, injected) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		// Cancel once the chosen rows exist: cleanup must not use the request context.
		log.reset(func(query string) error {
			if strings.Contains(query, "qt_identity_count>1") {
				cancel()
			}
			return nil
		})
		if err := run(t, ctx, q); !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
	for name, rows := range map[string]string{
		"duplicate": `('1','a',1,NULL,'x'),('1','a',2,NULL,'y'),('2','b',1,NULL,'z')`,
		"missing":   `('1','a',1,NULL,'x'),(NULL,'a',2,NULL,'y'),('2','b',1,NULL,'z')`,
	} {
		t.Run(name, func(t *testing.T) {
			log.reset(nil)
			if _, err := db.Exec("DELETE FROM source; INSERT INTO source VALUES " + rows); err != nil {
				t.Fatal(err)
			}
			var diag *qt.PlanDiagnostic
			if err := run(t, context.Background(), q); !errors.As(err, &diag) || diag.Code != "duplicate_identity" {
				t.Fatalf("got %v", err)
			}
			if n := log.count("qt_rank"); n != 1 {
				t.Fatalf("representative plan evaluated %d times", n)
			}
		})
	}
}

const v3Rows = `('1','a',1,'2026-11-01T05:15:00.000Z','old'),('2','a',3,'2026-11-01T05:45:00.000Z',NULL),('3','a',3,'2026-11-01T06:15:00.000Z','tie'),('4','b',10,'2026-11-01T07:15:00.000Z','b'),('5','',2,NULL,'empty'),('6',NULL,4,NULL,'null')`

// afterStaging installs a hook that snapshots the function counters once the
// source table (the request's first temporary table) exists. The returned
// function reports calls made after that point.
func afterStaging(log *statementLog) func(string) int64 {
	var snapshot map[string]int64
	staged := false
	log.reset(func(query string) error {
		if staged && snapshot == nil {
			snapshot = map[string]int64{}
			for name, calls := range sqliteCalls {
				snapshot[name] = calls.Load()
			}
		}
		staged = staged || strings.HasPrefix(query, "CREATE TEMP TABLE ")
		return nil
	})
	return func(name string) int64 {
		if snapshot == nil {
			return -1
		}
		return sqliteCalls[name].Load() - snapshot[name]
	}
}

func TestV3StagedValuesAreNotRevalidated(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, v3Rows)
	q := groupedRequest()
	q.Grouping.Summaries = append(q.Grouping.Summaries,
		qt.SummaryColumn{ID: "first", Op: "min", Field: "at"},
		qt.SummaryColumn{ID: "last", Op: "max", Field: "at"},
		qt.SummaryColumn{ID: "row_at", Op: "row", Field: "at"},
		qt.SummaryColumn{ID: "lazy", Op: "formula", Expression: "IF(TRUE,SUM([n]),SUM([n]/0))"},
		qt.SummaryColumn{ID: "bad", Op: "formula", Expression: "SUM([n]/0)"})
	q.Result = qt.WireQuery{Select: []string{"k", "num", "total", "first", "last", "row_at", "lazy", "bad", "example"}, Where: []qt.WhereTerm{{Field: "num", Op: ">=", Value: "1"}}, OrderBy: qt.OrderBys{{Field: "first", Dir: "desc", Nulls: "last"}}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "latest", Op: "max", Field: "first"}, {ID: "sum", Op: "sum", Field: "lazy", Scope: "shownRows"}, {ID: "bad", Op: "sum", Field: "bad"}, {ID: "by_first", Op: "count", GroupBy: []string{"first"}}}
	calls := afterStaging(log)
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Staging decoded and validated every value; nothing after it repeats that.
	for _, name := range []string{"qt_v2_datetime", "qt_v2_field_error"} {
		if n := calls(name); n != 0 {
			t.Fatalf("%s ran %d times after staging", name, n)
		}
	}
	divide := map[string]any{"computedError": "divide_by_zero"}
	want := []map[string]any{
		{"k": "b", "num": float64(1), "total": float64(10), "first": "2026-11-01T07:15:00.000Z", "last": "2026-11-01T07:15:00.000Z", "row_at": "2026-11-01T07:15:00.000Z", "lazy": float64(10), "bad": divide, "example": "b"},
		{"k": "a", "num": float64(3), "total": float64(7), "first": "2026-11-01T05:15:00.000Z", "last": "2026-11-01T06:15:00.000Z", "row_at": "2026-11-01T06:15:00.000Z", "lazy": float64(7), "bad": divide, "example": "tie"},
		{"k": "", "num": float64(1), "total": float64(2), "first": nil, "last": nil, "row_at": nil, "lazy": float64(2), "bad": divide, "example": "empty"},
		{"k": nil, "num": float64(1), "total": float64(4), "first": nil, "last": nil, "row_at": nil, "lazy": float64(4), "bad": divide, "example": "null"},
	}
	if len(out.Rows) != len(want) {
		t.Fatal(out.Rows)
	}
	for i, row := range out.Rows {
		delete(row, qt.GroupIdentityField)
		// NULL-first ties order by the group identity: "" before NULL.
		if !reflect.DeepEqual(row, want[i]) {
			t.Fatalf("row %d: got %#v want %#v", i, row, want[i])
		}
	}
	metrics := map[string]qt.SQLiteMetricV2{}
	for _, m := range out.Metrics {
		metrics[m.ID] = m
	}
	if m := metrics["latest"]; m.Error != "" || m.Buckets[0].Value != "2026-11-01T07:15:00.000Z" {
		t.Fatalf("latest: %#v", m)
	}
	if m := metrics["sum"]; m.Error != "" || m.Buckets[0].Value != float64(23) {
		t.Fatalf("sum: %#v", m)
	}
	if m := metrics["bad"]; m.Buckets[0].Error != "divide_by_zero" {
		t.Fatalf("bad: %#v", m)
	}
	if m := metrics["by_first"]; m.Error != "" || m.GroupCount != 3 {
		t.Fatalf("by_first: %#v", m)
	}

	// Ungrouped rows, sorting and metrics read the staged values directly too.
	q = groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id", "at", "label"}, OrderBy: qt.OrderBys{{Field: "at", Dir: "desc", Nulls: "last"}}, Limit: 3}
	q.Metrics = []qt.AggSpec{{ID: "first", Op: "min", Field: "at", GroupBy: []string{"k"}}, {ID: "total", Op: "sum", Field: "n", Scope: "shownRows"}}
	calls = afterStaging(log)
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"qt_v2_datetime", "qt_v2_field_error"} {
		if n := calls(name); n != 0 {
			t.Fatalf("ungrouped %s ran %d times after staging", name, n)
		}
	}
	if got := []any{out.Rows[0]["id"], out.Rows[0]["at"], out.Rows[1]["id"], out.Rows[2]["id"]}; !reflect.DeepEqual(got, []any{"4", "2026-11-01T07:15:00.000Z", "3", "2"}) {
		t.Fatal(out.Rows)
	}
	if out.Metrics[0].GroupCount != 4 || out.Metrics[1].Buckets[0].Value != float64(16) {
		t.Fatal(out.Metrics)
	}
}

func TestV3CallerStorageIsStillValidated(t *testing.T) {
	for _, c := range []struct{ name, field, rows string }{
		{"number", "n", `('1','a','oops',NULL,'x')`},
		{"datetime", "at", `('1','a',1,'not a time','x')`},
		{"text", "label", `('1','a',1,NULL,X'ff')`},
		{"bool", "flag", `('1','a',2,NULL,'x')`},
	} {
		t.Run(c.name, func(t *testing.T) {
			db, d := hookedV3(t, &statementLog{}, c.rows+`,('2','b',1,NULL,'y')`)
			d.Schema.Fields["flag"] = qt.FieldSpec{Name: "flag", Kind: qt.FieldBool, Expr: "r.n", Sortable: true, ServerFilter: true}
			ungrouped := groupedRequest()
			ungrouped.Grouping = nil
			ungrouped.Result = qt.WireQuery{Select: []string{"id", c.field}, Limit: 10}
			grouped := groupedRequest()
			grouped.Grouping.Summaries = []qt.SummaryColumn{{ID: "value", Op: "row", Field: c.field}}
			grouped.Result = qt.WireQuery{Select: []string{"k", "value"}, Limit: 10}
			for _, q := range []qt.QueryRequestV3{ungrouped, grouped} {
				var diag *qt.PlanDiagnostic
				if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "invalid_source_value" {
					t.Fatalf("invalid %s storage: %v", c.field, err)
				}
			}
		})
	}
}

// Plain staged text is unbounded; formula inputs over it keep the 100,000-byte
// bound as a per-value text_range error.
func TestV3StagedTextKeepsFormulaBound(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, `('1','a',1,NULL,'tie'),('2','a',2,NULL,'`+longText+`'),('3','b',3,NULL,'tie')`)
	q := groupedRequest()
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"label"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "chosen", Op: "row", Field: "label"}}, Representative: &qt.RepresentativeRow{OrderBy: qt.OrderBys{{Field: "id", Dir: "asc"}}}}
	q.Result = qt.WireQuery{Select: []string{"label", "num", "chosen"}, OrderBy: qt.OrderBys{{Field: "num", Dir: "desc"}}, Limit: 10}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Rows) != 2 || out.Rows[0]["label"] != "tie" || out.Rows[0]["num"] != float64(2) ||
		!reflect.DeepEqual(out.Rows[1]["label"], map[string]any{"computedError": "text_range"}) || out.Rows[1]["chosen"] != longText {
		t.Fatalf("long text group: %d rows, first %#v", len(out.Rows), out.Rows[0])
	}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "ties", Op: "formula", Expression: `SUM(IF([label]="tie",1,0))`}, {ID: "chosen", Op: "row", Field: "label"}}, Representative: &qt.RepresentativeRow{OrderBy: qt.OrderBys{{Field: "id", Dir: "desc"}}}}
	q.Result = qt.WireQuery{Select: []string{"k", "ties", "chosen"}, OrderBy: qt.OrderBys{{Field: "k", Dir: "asc"}}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "chosen", Op: "count", GroupBy: []string{"chosen"}}}
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Rows[0]["ties"], map[string]any{"computedError": "text_range"}) || out.Rows[0]["chosen"] != longText || out.Rows[1]["ties"] != float64(1) {
		t.Fatalf("formula over long text: %#v %#v", out.Rows[0]["ties"], out.Rows[1])
	}
	// A long ROW value used as a downstream group key is a formula input, too.
	keys := map[any]bool{}
	for _, bucket := range out.Metrics[0].Buckets {
		keys[bucket.Keys[0] == "tie"] = true
		if bucket.Keys[0] != "tie" && bucket.Error == "" {
			t.Fatalf("long downstream key: %#v", bucket)
		}
	}
	if len(keys) != 2 {
		t.Fatal(out.Metrics[0])
	}
}

func TestV3StagedPoliciesAndDiagnostics(t *testing.T) {
	db, d := hookedV3(t, &statementLog{}, v3Rows)
	q := groupedRequest()
	q.Grouping.Summaries = []qt.SummaryColumn{{ID: "total", Op: "sum", Field: "n"}}
	q.Result = qt.WireQuery{Select: []string{"k", "total"}, Limit: 10}
	var diag *qt.PlanDiagnostic
	unbounded := d
	unbounded.Schema.Fields = map[string]qt.FieldSpec{}
	for name, field := range d.Schema.Fields {
		unbounded.Schema.Fields[name] = field
	}
	n := unbounded.Schema.Fields["n"]
	n.ExpressionNumeric = false
	unbounded.Schema.Fields["n"] = n
	if _, err := unbounded.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "numeric_domain_required" {
		t.Fatalf("numeric domain: %v", err)
	}
	n.ExpressionNumeric, n.AggregateOps = true, []string{"sum"}
	unbounded.Schema.Fields["n"] = n
	if _, err := unbounded.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	q.Grouping.Summaries = []qt.SummaryColumn{{ID: "total", Op: "avg", Field: "n"}}
	if _, err := unbounded.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "aggregate_disabled" {
		t.Fatalf("aggregate policy: %v", err)
	}
	// A result metric over a staged field keeps that field's policy, too.
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "avg", Op: "avg", Field: "n"}}
	out, err := unbounded.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Metrics[0].Error == "" {
		t.Fatalf("metric policy: %#v %v", out.Metrics, err)
	}
}

// Hidden and default sorts, a field sorted by another, and enum kinds survive
// staging and the representative rows.
func TestV3StagedSortsAndEnums(t *testing.T) {
	db, d := hookedV3(t, &statementLog{}, v3Rows)
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 2, OrderBy: qt.OrderBys{{Field: "n", Dir: "desc"}}}
	plan, err := d.SourcePlan(context.Background(), q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(plan.Fields, []string{"id", "n"}) {
		t.Fatal(plan.Fields, err)
	}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" || out.Rows[1]["id"] != "6" {
		t.Fatal(out.Rows, err)
	}
	d.Schema.DefaultSort = q.Result.OrderBy
	q.Result.OrderBy = nil
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" || out.Rows[1]["id"] != "6" {
		t.Fatal(out.Rows, err)
	}
	label := d.Schema.Fields["label"]
	label.SQLiteSortField, label.SortExpr = "n", "r.n"
	d.Schema.Fields["label"] = label
	q.Result.OrderBy = qt.OrderBys{{Field: "label", Dir: "desc"}}
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || out.Rows[0]["id"] != "4" || out.Rows[1]["id"] != "6" {
		t.Fatal(out.Rows, err)
	}
	k := d.Schema.Fields["k"]
	k.Kind = qt.FieldEnum
	d.Schema.Fields["k"] = k
	q = groupedRequest()
	q.Grouping.Summaries = []qt.SummaryColumn{{ID: "chosen", Op: "row", Field: "k"}, {ID: "smallest", Op: "min", Field: "k"}, {ID: "total", Op: "sum", Field: "n"}}
	q.Result = qt.WireQuery{Select: []string{"k", "chosen", "smallest"}, Where: []qt.WhereTerm{{Field: "smallest", Op: "=", Value: "a"}}, OrderBy: qt.OrderBys{{Field: "total", Dir: "desc"}}, Limit: 10}
	out, err = d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range out.Schema.Fields {
		if (field.Name == "k" || field.Name == "chosen" || field.Name == "smallest") != (field.Type == "enum") {
			t.Fatal(out.Schema)
		}
	}
	if len(out.Rows) != 1 || out.Rows[0]["chosen"] != "a" || out.Rows[0]["smallest"] != "a" {
		t.Fatal(out.Rows)
	}
}
