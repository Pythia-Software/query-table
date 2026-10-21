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

func syntheticCatalog(db *sql.DB, n int) error {
	for i := 0; i < n; i++ {
		if _, err := db.Exec(fmt.Sprintf("CREATE VIEW catalog_%d AS SELECT %d AS n", i, i)); err != nil {
			return err
		}
	}
	return nil
}
func TestSQLiteScratchCommitLifecycle(t *testing.T) {
	for _, store := range []int{1, 2} {
		t.Run(fmt.Sprint(store), func(t *testing.T) {
			db, d := setupV3(t)
			db.SetMaxOpenConns(1)
			if err := syntheticCatalog(db, 578); err != nil {
				t.Fatal(err)
			}
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if _, err = conn.ExecContext(context.Background(), fmt.Sprintf("PRAGMA temp_store=%d", store)); err != nil {
				t.Fatal(err)
			}
			if _, err = conn.ExecContext(context.Background(), "CREATE TEMP TABLE host_scratch(value); INSERT INTO host_scratch VALUES(17)"); err != nil {
				t.Fatal(err)
			}
			q := groupedRequest()
			var original qt.QueryResultV3
			for i := 0; i < 3; i++ {
				tx, err := conn.BeginTx(context.Background(), nil)
				if err != nil {
					t.Fatal(err)
				}
				result, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
				if err != nil {
					tx.Rollback()
					t.Fatal(err)
				}
				if i == 0 {
					original = result
				} else if !reflect.DeepEqual(result, original) {
					t.Fatal("reused connection changed result")
				}
				if n := tempTables(t, tx); n != 0 {
					t.Fatalf("%d leaked scratch tables", n)
				}
				if err := tx.Commit(); err != nil {
					t.Fatal(err)
				}
			}
			var n int
			if err := conn.QueryRowContext(context.Background(), "SELECT value FROM host_scratch").Scan(&n); err != nil || n != 17 {
				t.Fatal("host scratch changed", n, err)
			}
			if err := conn.QueryRowContext(context.Background(), "PRAGMA temp_store").Scan(&n); err != nil || n != store {
				t.Fatal("temp_store changed", n, err)
			}
		})
	}
}
func TestSQLiteScratchCleanupFailureIsReturned(t *testing.T) {
	for _, representative := range []bool{false, true} {
		t.Run(fmt.Sprint(representative), func(t *testing.T) {
			log := &statementLog{}
			db, d := hookedV3(t, log, representativeRows)
			q := representativeRequest(qt.OrderBy{Field: "n", Dir: "desc"})
			if !representative {
				q.Grouping.Summaries = q.Grouping.Summaries[:1]
				q.Grouping.Representative = nil
				q.Result.Select = []string{"k", "num"}
			}
			sentinel := errors.New("injected scratch cleanup failure")
			failed := false
			log.reset(func(query string) error {
				if !failed && strings.HasPrefix(query, "DROP TABLE IF EXISTS ") {
					failed = true
					return sentinel
				}
				return nil
			})
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			out, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
			if !errors.Is(err, sentinel) || out.Version != 0 {
				t.Fatalf("cleanup failure returned success: %#v %v", out, err)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			log.reset(nil)
			var n int
			if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_temp_master WHERE name LIKE 'qt_v3_%'").Scan(&n); err != nil || n != 0 {
				t.Fatal("rollback cleanup", n, err)
			}
		})
	}
}
func TestSQLiteScratchCancelledTransactionRollsBack(t *testing.T) {
	log := &statementLog{}
	db, d := hookedV3(t, log, representativeRows)
	if err := syntheticCatalog(db, 578); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log.reset(func(query string) error {
		if strings.HasPrefix(query, "CREATE TEMP TABLE") {
			cancel()
		}
		return nil
	})
	if _, err = d.ExecuteIn(ctx, tx, representativeRequest(qt.OrderBy{Field: "n", Dir: "desc"}), qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	tx.Rollback()
	log.reset(nil)
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if n := tempTables(t, tx); n != 0 {
		t.Fatalf("%d scratch objects after rollback", n)
	}
	if _, err = d.ExecuteIn(context.Background(), tx, representativeRequest(qt.OrderBy{Field: "n", Dir: "desc"}), qt.PlanOptions{}); err != nil {
		t.Fatal("connection not reusable", err)
	}
}
