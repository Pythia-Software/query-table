package postgrestests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"os"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func isolationQuery() qt.QueryRequestV3 {
	q := groupedQuery()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, OrderBy: qt.OrderBys{{Field: "id", Dir: "asc"}}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}, {ID: "median", Expression: "MEDIAN([n])", GroupBy: []string{"k"}}, {ID: "count", Op: "count"}}
	return q
}

func assertMiddleMetricFailed(t *testing.T, out qt.QueryResultV3, rows int, sum float64, message string) {
	t.Helper()
	if len(out.Rows) != rows || len(out.Metrics) != 3 {
		t.Fatalf("rows=%d metrics=%d", len(out.Rows), len(out.Metrics))
	}
	first, middle, last := out.Metrics[0], out.Metrics[1], out.Metrics[2]
	if first.Error != "" || first.Buckets[0].Value != sum || last.Error != "" || last.Buckets[0].Value != float64(rows) {
		t.Fatalf("siblings: %#v %#v", first, last)
	}
	if middle.ID != "median" || middle.Error != message || len(middle.Buckets) != 0 {
		t.Fatalf("middle: %#v", middle)
	}
}

func TestPostgresMetricSampleBudgetFailsOnlyThatMetric(t *testing.T) {
	db, d := fixture(t)
	d.MaxSamplesPerGroup = 2
	out, err := d.Execute(context.Background(), db, isolationQuery(), qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertMiddleMetricFailed(t, out, 6, 23, "MEDIAN exceeded the 2-sample budget for one or more groups")
}

// failingQueryConn makes the real server fail one statement, which aborts the
// PostgreSQL transaction exactly as a statement timeout or temp file limit would.
type failingQueryConn struct {
	driver.Conn
	driver.ConnBeginTx
	queryer driver.QueryerContext
	execer  driver.ExecerContext
	fail    func(string) bool
}

func (c failingQueryConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if c.fail(query) {
		rows, err := c.queryer.QueryContext(ctx, "SELECT 1/0", nil)
		if err == nil {
			rows.Close()
			return nil, errors.New("injected statement did not fail")
		}
		return nil, err
	}
	return c.queryer.QueryContext(ctx, query, args)
}
func (c failingQueryConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.execer.ExecContext(ctx, query, args)
}

type failingQueryConnector struct {
	base driver.Driver
	fail func(string) bool
}

func (c failingQueryConnector) Driver() driver.Driver { return c.base }
func (c failingQueryConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(os.Getenv("QT_TEST_POSTGRES"))
	if err != nil {
		return nil, err
	}
	return failingQueryConn{Conn: conn, ConnBeginTx: conn.(driver.ConnBeginTx), queryer: conn.(driver.QueryerContext), execer: conn.(driver.ExecerContext), fail: c.fail}, nil
}

func TestPostgresFailedMetricStatementKeepsTransactionUsable(t *testing.T) {
	original, d := fixture(t)
	db := sql.OpenDB(failingQueryConnector{base: original.Driver(), fail: func(query string) bool {
		return strings.Contains(query, "percentile_cont")
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = `SELECT i::text AS id,CASE WHEN i%2=0 THEN 'a' ELSE 'b' END AS k,i::double precision AS n,NULL::timestamptz AS at,NULL::text AS label FROM generate_series(1,10) AS nums(i)`
	// Execute commits after the metrics, so this also proves the savepoint
	// restored the transaction rather than leaving it aborted.
	out, err := d.Execute(context.Background(), db, isolationQuery(), qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertMiddleMetricFailed(t, out, 10, 55, "could not execute metric")

	// The caller-owned transaction remains usable after the batch, too.
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if out, err = d.ExecuteIn(context.Background(), tx, isolationQuery(), qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	assertMiddleMetricFailed(t, out, 10, 55, "could not execute metric")
	var one int
	if err = tx.QueryRow("SELECT 1").Scan(&one); err != nil || one != 1 {
		t.Fatalf("transaction aborted after isolated metric failure: %v", err)
	}
}

func TestPostgresRequestLevelMetricFailuresStillFail(t *testing.T) {
	db, d := fixture(t)
	q := isolationQuery()
	q.Metrics[2].ID = "sum"
	var diag *qt.PlanDiagnostic
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "duplicate_metric" {
		t.Fatalf("duplicate IDs: %v", err)
	}
	q = isolationQuery()
	q.Metrics[1].Scope = "visible"
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "scope" {
		t.Fatalf("bad scope: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := d.Execute(ctx, db, isolationQuery(), qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
