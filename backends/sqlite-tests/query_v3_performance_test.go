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
