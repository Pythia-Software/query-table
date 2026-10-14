package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestCalendarQueryRangeIgnoresClearedFilters(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10, Where: []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-11-01"}, {Field: "at", Op: "<=", Value: "2026-11-05"}, {Field: "at", Op: ">", Value: ""}}}
	q.Metrics = []qt.AggSpec{{ID: "days", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "query", IncludeEmpty: true}}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || len(out.Metrics) != 1 || len(out.Metrics[0].Buckets) != 5 {
		t.Fatalf("cleared date: %#v, %v", out, err)
	}
	q.Result.Where = q.Result.Where[:2]
	want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(out.Rows, want.Rows) || !reflect.DeepEqual(out.Metrics, want.Metrics) {
		t.Fatalf("empty predicate changed results: %#v / %#v, %v", out, want, err)
	}
}

type calendarProbeConnector struct {
	base  driver.Driver
	probe func(driver.Conn, string, int)
}

func (c calendarProbeConnector) Driver() driver.Driver { return c.base }
func (c calendarProbeConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(":memory:")
	if err != nil {
		return nil, err
	}
	return calendarProbeConn{Conn: conn, QueryerContext: conn.(driver.QueryerContext), ConnBeginTx: conn.(driver.ConnBeginTx), probe: c.probe}, nil
}

type calendarProbeConn struct {
	driver.Conn
	driver.QueryerContext
	driver.ConnBeginTx
	probe func(driver.Conn, string, int)
}

func (c calendarProbeConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	result, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
	if err == nil {
		c.probe(c.Conn, query, len(args))
	}
	return result, err
}

func TestCalendarScratchIsNarrowBatchedAndReleasedPerMetric(t *testing.T) {
	original, d := setupV3(t)
	active := map[string]bool{}
	maxActive, updates, maxArgs := 0, 0, 0
	var columns []int
	db := sql.OpenDB(calendarProbeConnector{base: original.Driver(), probe: func(conn driver.Conn, query string, args int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") && strings.Contains(query, "qt_calendar_source") {
			name := strings.Fields(query)[3]
			active[name] = true
			if len(active) > maxActive {
				maxActive = len(active)
			}
			rows, err := conn.(driver.QueryerContext).QueryContext(context.Background(), "PRAGMA table_info("+name+")", nil)
			if err != nil {
				t.Fatal(err)
			}
			count := 0
			values := make([]driver.Value, len(rows.Columns()))
			for {
				err = rows.Next(values)
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				count++
			}
			rows.Close()
			columns = append(columns, count)
		}
		if strings.HasPrefix(query, "DROP TABLE IF EXISTS ") {
			delete(active, strings.Fields(query)[4])
		}
		if strings.HasPrefix(query, "WITH qt_calendar_keys") {
			updates++
			if args > maxArgs {
				maxArgs = args
			}
		}
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = `WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<1001)
 SELECT CAST(i AS TEXT) id,'key' k,1 n,CASE WHEN i<=400 THEN NULL ELSE '2026-11-01T12:00:00.000Z' END at,printf('%.*c',8192,'x') label FROM nums`
	q := groupedRequest()
	q.Grouping = nil
	q.Rows = false
	q.Result = qt.WireQuery{Select: []string{"id", "k", "n", "at", "label"}, Limit: 10}
	date := &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}
	q.Metrics = []qt.AggSpec{{ID: "days", Op: "count", GroupBy: []string{"at"}, DateGrouping: date}, {ID: "sums", Op: "sum", Field: "n", GroupBy: []string{"at"}, DateGrouping: date}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if maxActive != 1 || len(active) != 0 || !reflect.DeepEqual(columns, []int{5, 7}) {
		t.Fatalf("calendar scratch: max=%d active=%v columns=%v", maxActive, active, columns)
	}
	if updates != 4 || maxArgs > 800 {
		t.Fatalf("calendar updates=%d parameters=%d", updates, maxArgs)
	}
	for _, metric := range out.Metrics {
		if len(metric.Buckets) != 2 {
			t.Fatal(metric)
		}
		for _, bucket := range metric.Buckets {
			want := float64(601)
			if bucket.Keys[0] == nil {
				want = 400
			}
			if bucket.Value != want {
				t.Fatal(metric)
			}
		}
	}
}

func TestCalendarScratchBudgetIncludesKeysBeforeCopy(t *testing.T) {
	original, d := setupV3(t)
	created := 0
	db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, _ int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") {
			created++
		}
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = "SELECT '1' id,NULL k,1 n,'2026-11-01T12:00:00.000Z' at,NULL label"
	d.MaxStagingBytes = 32 // Source is 25 bytes; calendar also needs ordinal + ISO key.
	q := groupedRequest()
	q.Grouping = nil
	q.Rows = false
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "day", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}}}
	var diag *qt.PlanDiagnostic
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "resource_limit" || !strings.Contains(diag.Message, "calendar") {
		t.Fatalf("calendar budget: %v", err)
	}
	if created != 1 {
		t.Fatalf("oversized calendar copy materialized %d temp tables", created)
	}
}

func TestCalendarShownRowsPreservesHiddenSort(t *testing.T) {
	db, d := setupV3(t)
	d.Schema.DefaultSort = []qt.OrderBy{{Field: "n", Dir: "desc"}}
	q := groupedRequest()
	q.Grouping = nil
	q.Rows = false
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 2}
	q.Metrics = []qt.AggSpec{{ID: "shown", Op: "sum", Field: "n", Scope: "shownRows", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sum := 0.0
	for _, b := range out.Metrics[0].Buckets {
		sum += b.Value.(float64)
	}
	if sum != 14 || out.Metrics[0].ProcessedRows != 2 {
		t.Fatal(out)
	}
}
