package postgrestests

import (
	"context"
	"database/sql"
	"errors"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"reflect"
	"strings"
	"testing"
)

func TestPostgresCalendarQueryRangeIgnoresClearedFilters(t *testing.T) {
	db, d := fixture(t)
	q := groupedQuery()
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

func TestPostgresCalendarShownRowsPreservesHiddenSort(t *testing.T) {
	db, d := fixture(t)
	d.Schema.DefaultSort = []qt.OrderBy{{Field: "n", Dir: "desc"}}
	q := groupedQuery()
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
func TestPostgresCalendarScratchBudgetIncludesKeysBeforeCopy(t *testing.T) {
	original, d := fixture(t)
	created := 0
	db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, _ int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") {
			created++
		}
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = "SELECT '1' id,NULL k,1 n,'2026-11-01T12:00:00Z'::timestamptz at,NULL label"
	d.MaxStagingBytes = 32 // Source is 25 bytes; calendar also needs ordinal + ISO key.
	q := groupedQuery()
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

func TestPostgresCalendarScratchBatchesAndLifetime(t *testing.T) {
	original, d := fixture(t)
	active := map[string]bool{}
	maxActive, updates, maxArgs := 0, 0, 0
	db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, args int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") && strings.Contains(query, "qt_calendar_source") {
			active[strings.Fields(query)[3]] = true
			if len(active) > maxActive {
				maxActive = len(active)
			}
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
	d.SourceSQL = `SELECT i::text AS id,'key'::text AS k,1::double precision AS n,CASE WHEN i<=400 THEN NULL ELSE '2026-11-01T12:00:00Z'::timestamptz END AS at,repeat('x',8192) AS label FROM generate_series(1,1001) AS nums(i)`
	q := groupedQuery()
	q.Grouping = nil
	q.Rows = false
	q.Result = qt.WireQuery{Select: []string{"id", "k", "n", "at", "label"}, Limit: 10}
	date := &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"}
	q.Metrics = []qt.AggSpec{{ID: "days", Op: "count", GroupBy: []string{"at"}, DateGrouping: date}, {ID: "sums", Op: "sum", Field: "n", GroupBy: []string{"at"}, DateGrouping: date}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if maxActive != 1 || len(active) != 0 || updates != 4 || maxArgs > 800 {
		t.Fatalf("scratch max=%d active=%v updates=%d args=%d", maxActive, active, updates, maxArgs)
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
