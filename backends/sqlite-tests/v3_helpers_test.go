package sqlitetests

import (
	"context"
	"database/sql"
	"sort"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Helpers for tests ported from the removed v1/v2 entry points to v3. Every
// request here is ungrouped, so it executes directly against SourceSQL.

// populationMarker identifies the population COUNT v3 sends before rows and
// metrics of an ungrouped request.
var v3Clock = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).UnixMilli()

const populationMarker = "\nSELECT COUNT(*) FROM "

// sqliteV3 is a SQLite v3 dataset over an authorized source SELECT.
func sqliteV3(s qt.Schema, sourceSQL string, args []any, scope, dataset string) qt.QueryDatasetV3 {
	return qt.QueryDatasetV3{Schema: s, SourceSQL: sourceSQL, SourceArgs: args, Scope: scope, Dataset: dataset, Dialect: "sqlite"}
}

// v3Request is an ungrouped v3 request over one result stage. v3 requires a
// result window, so a zero limit becomes 1; allMatching metrics ignore it.
func v3Request(result qt.WireQuery, rows bool, metrics ...qt.AggSpec) qt.QueryRequestV3 {
	if result.Limit == 0 {
		result.Limit = 1
	}
	// v1/v2 defaulted the evaluation clock to the wall clock; v3 requires one.
	// A fixed clock keeps result envelopes (which echo it) comparable.
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: v3Clock, Rows: rows, Result: result, Metrics: metrics}
}

// metricsV3 is a metrics-only request over where, order and window.
func metricsV3(where []qt.WhereTerm, orderBy []qt.OrderBy, limit, offset int, metrics ...qt.AggSpec) qt.QueryRequestV3 {
	return v3Request(qt.WireQuery{Where: where, OrderBy: orderBy, Limit: limit, Offset: offset}, false, metrics...)
}

// rowsV3 is a rows-only request for one page.
func rowsV3(page qt.WireQuery) qt.QueryRequestV3 { return v3Request(page, true) }

// metricV2 is a single formula metric named "m" over every source row.
func metricV2(expression string) qt.QueryRequestV3 {
	return metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "m", Expression: expression})
}

func executeV3(t testing.TB, db *sql.DB, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) qt.QueryResultV3 {
	t.Helper()
	r, err := d.Execute(context.Background(), db, q, o)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func executeV3Tx(t testing.TB, tx *sql.Tx, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) qt.QueryResultV3 {
	t.Helper()
	r, err := d.ExecuteIn(context.Background(), tx, q, o)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// executeMetricsV3 runs metrics in tx and returns them in request order.
func executeMetricsV3(t testing.TB, tx *sql.Tx, d qt.QueryDatasetV3, where []qt.WhereTerm, orderBy []qt.OrderBy, limit, offset int, metrics ...qt.AggSpec) []qt.MetricResult {
	t.Helper()
	return executeV3Tx(t, tx, d, metricsV3(where, orderBy, limit, offset, metrics...), qt.PlanOptions{}).Metrics
}

// runMetric executes q in its own transaction and returns its first metric.
func runMetric(t testing.TB, db *sql.DB, d qt.QueryDatasetV3, q qt.QueryRequestV3) qt.MetricResult {
	t.Helper()
	return executeV3(t, db, d, q, qt.PlanOptions{}).Metrics[0]
}

// metricFailure asserts that a request succeeded but its only metric failed.
func metricFailure(t testing.TB, r qt.QueryResultV3, e error) string {
	t.Helper()
	if e != nil {
		t.Fatalf("clause failure failed the request: %v", e)
	}
	m := r.Metrics[0]
	if m.Error == "" || len(m.Buckets) != 0 {
		t.Fatalf("clause failure not reported on the metric: %#v", m)
	}
	return m.Error
}

// ids lists the identity of each row in order.
func ids(r qt.QueryResultV3) []string {
	result := []string{}
	for _, row := range r.Rows {
		result = append(result, row["id"].(string))
	}
	return result
}

// describeComputedIn is the removed all-or-error handshake: it describes ids
// with DescribeComputedPartialIn and fails with the first (by ID) diagnostic.
func describeComputedIn(ctx context.Context, tx *sql.Tx, d qt.QueryDatasetV3, ids []string, o qt.PlanOptions) (qt.ComputedExecution, error) {
	description, err := d.DescribeComputedPartialIn(ctx, tx, ids, o)
	if err != nil {
		return qt.ComputedExecution{}, err
	}
	failed := []string{}
	for id := range description.Diagnostics {
		failed = append(failed, id)
	}
	sort.Strings(failed)
	if len(failed) > 0 {
		return qt.ComputedExecution{}, description.Diagnostics[failed[0]]
	}
	return description.Execution, nil
}

// distinctV3 requests filter suggestions for field over every source row.
func distinctV3(field, search string, limit int) qt.QueryRequestV3 {
	q := v3Request(qt.WireQuery{}, false)
	q.Distinct = &qt.DistinctRequestV3{Field: field, Search: search, Limit: limit}
	return q
}
