package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Seed a same-named main table immediately before scratch DDL, on the same
// connection. This covers random V3 names without relying on a naming sequence.
func mainTableCollisionHook(tables map[string]bool) func(context.Context, driver.Conn, string) error {
	return func(ctx context.Context, conn driver.Conn, query string) error {
		if !strings.HasPrefix(query, "CREATE TEMP TABLE ") {
			return nil
		}
		table := strings.Fields(query)[3]
		if tables[table] {
			return nil
		}
		_, err := conn.(driver.ExecerContext).ExecContext(ctx, "CREATE TABLE main."+table+"(sentinel); INSERT INTO main."+table+" VALUES(17)", nil)
		if err == nil {
			tables[table] = true
		}
		return err
	}
}

func assertMainTables(t *testing.T, tx *sql.Tx, tables map[string]bool) {
	t.Helper()
	if len(tables) == 0 {
		t.Fatal("no scratch collisions exercised")
	}
	for table := range tables {
		var value int
		if err := tx.QueryRow("SELECT sentinel FROM main." + table).Scan(&value); err != nil || value != 17 {
			t.Fatalf("host table %s changed: sentinel=%d, error=%v", table, value, err)
		}
	}
}

func TestV2CleanupPreservesMainTables(t *testing.T) {
	for _, overflow := range []bool{true, false} {
		name := "failed fusion"
		if overflow {
			name = "integer overflow"
		}
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			tables := map[string]bool{}
			seed := mainTableCollisionHook(tables)
			armed, failed := false, false
			db := hookedDBWithExecHook(t, log, crossFieldDDL(30), func(ctx context.Context, conn driver.Conn, query string) error {
				if !armed {
					return nil
				}
				if err := seed(ctx, conn, query); err != nil {
					return err
				}
				if !overflow && !failed && strings.HasPrefix(query, "CREATE TEMP TABLE ") {
					failed = true
					return errors.New("injected CTAS failure before TEMP creation")
				}
				return nil
			})
			d := qt.SQLiteV2Dataset{Schema: crossFieldSchema(), SourceSQL: "SELECT * FROM source WHERE tenant=?1", SourceArgs: []any{"allowed"}}
			q := crossFieldQuery(false)
			if overflow {
				if _, err := db.Exec("UPDATE source SET n0=9223372036854775807 WHERE id IN ('00000001','00000002')"); err != nil {
					t.Fatal(err)
				}
			} else {
				// Same-input fusion leaves its failed CTAS entry for cache.close.
				q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n0"}, {ID: "avg", Op: "avg", Field: "n0"}}
			}
			want, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			armed = true
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			got, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
			if err != nil || !reflect.DeepEqual(got.Metrics, want.Metrics) {
				t.Fatalf("fallback changed results: got %#v, want %#v, error=%v", got.Metrics, want.Metrics, err)
			}
			if !overflow && !failed {
				t.Fatal("fusion did not fail")
			}
			assertNoReductions(t, tx)
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			tx, err = db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			assertMainTables(t, tx, tables)
		})
	}
}

func TestV3CleanupPreservesMainTables(t *testing.T) {
	for _, failedCTAS := range []bool{true, false} {
		name := "calendar repeated cleanup"
		if failedCTAS {
			name = "failed source staging"
		}
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			tables := map[string]bool{}
			seed := mainTableCollisionHook(tables)
			sentinel := errors.New("injected CTAS failure before TEMP creation")
			db := hookedDBWithExecHook(t, log, "CREATE TABLE source(id TEXT,k TEXT,n REAL,at TEXT,label TEXT); INSERT INTO source VALUES "+representativeRows, func(ctx context.Context, conn driver.Conn, query string) error {
				if err := seed(ctx, conn, query); err != nil {
					return err
				}
				if failedCTAS && strings.HasPrefix(query, "CREATE TEMP TABLE ") {
					return sentinel
				}
				return nil
			})
			_, d := setupV3(t)
			d.SourceSQL = "SELECT * FROM source"
			q := groupedRequest()
			if !failedCTAS {
				q.Grouping = nil
				q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
				q.Metrics = []qt.AggSpec{{ID: "days", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}}}
			}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			out, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
			if failedCTAS {
				if !errors.Is(err, sentinel) {
					t.Fatal("expected staging failure", err)
				}
				assertMainTables(t, tx, tables)
				return // Failed executions still require caller rollback.
			}
			if err != nil || len(out.Metrics) != 1 || out.Metrics[0].Error != "" {
				t.Fatal(out, err)
			}
			if n := tempTables(t, tx); n != 0 {
				t.Fatalf("%d leaked scratch tables", n)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			tx, err = db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			assertMainTables(t, tx, tables)
		})
	}
}
