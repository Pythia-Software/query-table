package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"modernc.org/sqlite"
)

var metricProbeCalls atomic.Int64
var metricProbeCancel func()
var metricProbeCancelAfter int64

func init() {
	if err := sqlite.RegisterDeterministicScalarFunction("qt_test_metric_probe", 1, func(_ *sqlite.FunctionContext, values []driver.Value) (driver.Value, error) {
		n := metricProbeCalls.Add(1)
		if metricProbeCancel != nil && n > metricProbeCancelAfter {
			metricProbeCancel()
		}
		return values[0], nil
	}); err != nil {
		panic(err)
	}
}

func setupReuse(t *testing.T) (*sql.DB, qt.SQLiteV2Dataset) {
	db, d := setupV2(t)
	d.SourceSQL = "SELECT *, qt_test_metric_probe(n) AS sample_n FROM runs WHERE tenant=?1"
	f := d.Schema.Fields["n"]
	f.Expr, f.SortExpr = "r.sample_n", "r.sample_n"
	d.Schema.Fields["n"] = f
	return db, d
}

func assertNoReductions(t *testing.T, tx *sql.Tx) {
	t.Helper()
	var count int
	if err := tx.QueryRow("SELECT COUNT(*) FROM sqlite_temp_master WHERE name GLOB '_qt_reduction_*'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("temporary reductions leaked: count=%d error=%v", count, err)
	}
}

func TestV2ReductionReuse(t *testing.T) {
	db, d := setupReuse(t)
	specs := []qt.AggSpec{
		{ID: "sum", Expression: "SUM([n])", GroupBy: []string{"flag"}},
		{ID: "same", Expression: "SUM([n])", GroupBy: []string{"flag"}},
		{ID: "plus", Expression: "SUM([n])+2", GroupBy: []string{"flag"}},
		{ID: "top", Expression: "SUM([n])+5", GroupBy: []string{"flag"}, Sort: []qt.MetricSort{{Key: "value", Dir: "desc"}}, GroupLimit: 1},
		{ID: "avg", Expression: "AVG([n])", GroupBy: []string{"flag"}},
		{ID: "min", Expression: "MIN([n])", GroupBy: []string{"flag"}},
		{ID: "shown", Expression: "SUM([n])+2", Scope: "shownRows", GroupBy: []string{"flag"}},
	}
	q := metricV2("")
	q.Metrics = specs
	q.Where = []qt.WhereTerm{{Field: "id", Op: "!=", Value: "c"}}
	q.Limit, q.Offset = 1, 1
	want := []qt.SQLiteMetricV2{}
	var singleCalls int64
	for i, spec := range specs {
		single := q
		single.Metrics = []qt.AggSpec{spec}
		metricProbeCalls.Store(0)
		want = append(want, runMetric(t, db, d, single))
		if i == 0 {
			singleCalls = metricProbeCalls.Load()
		}
	}
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, indices := range [][]int{{0, 1}, {0, 2, 3}, {0, 1, 2, 3, 4, 5}, {0, 1, 2, 3, 4, 5, 6}} {
		batch := q
		batch.Metrics = nil
		expected := []qt.SQLiteMetricV2{}
		for _, i := range indices {
			batch.Metrics = append(batch.Metrics, specs[i])
			expected = append(expected, want[i])
		}
		metricProbeCalls.Store(0)
		result, err := d.ExecuteV2In(ctx, tx, nil, &batch, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result.Metrics.Metrics, expected) {
			t.Fatalf("batch %v differs: got %+v want %+v", indices, result.Metrics.Metrics, expected)
		}
		calls := metricProbeCalls.Load()
		if indices[len(indices)-1] != 6 && (calls != singleCalls || calls == 0) {
			t.Fatalf("batch %v visited %d samples; one scan visits %d", indices, calls, singleCalls)
		}
		if indices[len(indices)-1] == 6 && (calls <= singleCalls || calls >= singleCalls*3) {
			t.Fatalf("scopes not independently shared: %d vs %d", calls, singleCalls)
		}
		assertNoReductions(t, tx)
	}
	// A final top-N cannot mask the group budget; errors still clean up the tables.
	limited := d
	limited.MaxGroups = 1
	guarded := q
	guarded.Metrics = specs[:6]
	if _, err := limited.ExecuteV2In(ctx, tx, nil, &guarded, qt.PlanOptions{}); err == nil {
		t.Fatal("shared reductions bypassed group budget")
	}
	assertNoReductions(t, tx)
	// Repeated execution must see changed data rather than reuse a prior cache.
	if _, err := tx.Exec("UPDATE runs SET n=8 WHERE id='a'"); err != nil {
		t.Fatal(err)
	}
	single := metricV2("SUM([n])")
	result, err := d.ExecuteV2In(ctx, tx, nil, &single, qt.PlanOptions{})
	if err != nil || result.Metrics.Metrics[0].Buckets[0].Value != float64(18) {
		t.Fatal(result, err)
	}
	q.Metrics = append(q.Metrics, qt.AggSpec{ID: "bad", Expression: "SUM([missing])"})
	metricProbeCalls.Store(0)
	if _, err := d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); err == nil || metricProbeCalls.Load() != 0 {
		t.Fatal("invalid batch executed", err)
	}
	q.Metrics = specs[:2]
	q.ExpectedRevisions = map[string]string{"hidden": "1"}
	opts := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: "hidden", Revision: "2"}, nil
	})}
	if _, err := d.ExecuteV2In(ctx, tx, nil, &q, opts); err == nil || metricProbeCalls.Load() != 0 {
		t.Fatal("stale revision envelope executed", err)
	}
}

func TestV2ReductionCancellationCleanup(t *testing.T) {
	db, d := setupReuse(t)
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	q := metricV2("")
	q.Metrics = []qt.AggSpec{{ID: "sum", Expression: "SUM([n])"}, {ID: "avg", Expression: "AVG([n])"}, {ID: "box", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	metricProbeCalls.Store(0)
	metricProbeCancel, metricProbeCancelAfter = cancel, 4
	defer func() { metricProbeCancel = nil }()
	if _, err := d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("wanted cancellation, got %v", err)
	}
	assertNoReductions(t, tx)
	// SQLite interruption may abort the transaction; the caller must roll back.
}

func TestV2IndexedWindow(t *testing.T) {
	db, d := setupV2(t)
	if _, err := db.Exec(`UPDATE runs SET stamp=CASE id WHEN 'a' THEN '2026-01-01T00:00:00.000Z' WHEN 'b' THEN '2026-01-02T00:00:00.000Z' WHEN 'd' THEN '2026-01-03T00:00:00.000Z' END; CREATE INDEX runs_tenant_stamp ON runs(tenant,stamp DESC,id)`); err != nil {
		t.Fatal(err)
	}
	f := d.Schema.Fields["stamp"]
	f.SQLiteDatetimeFormat = "utc-millis"
	d.Schema.Fields["stamp"] = f
	q := metricV2("SUM([n])")
	q.Metrics[0].Scope = "shownRows"
	q.OrderBy = []qt.OrderBy{{Field: "stamp", Dir: "desc"}}
	q.Where = []qt.WhereTerm{{Field: "stamp", Op: ">", Value: "2025-01-01T00:00:00Z"}}
	q.Limit = 1
	batch, err := qt.CompileSQLiteMetrics(context.Background(), q, d.Schema, qt.PlanOptions{SourceSQL: d.SourceSQL, SourceArgs: d.SourceArgs})
	if err != nil {
		t.Fatal(err)
	}
	p := batch.Metrics[0]
	rows, err := db.Query("EXPLAIN QUERY PLAN "+p.SQL, p.Args...)
	if err != nil {
		t.Fatal(err)
	}
	var details []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	explain := strings.Join(details, "\n")
	if !strings.Contains(explain, "runs_tenant_stamp") || p.Stages[1].Materialized {
		t.Fatalf("window lost its index:\n%s", explain)
	}
	m := runMetric(t, db, d, q)
	if m.Buckets[0].Value != float64(6) {
		t.Fatal(m)
	}
	// Selected fields still validate trusted storage after the window.
	if _, err := db.Exec("UPDATE runs SET stamp='bad' WHERE id='d'"); err != nil {
		t.Fatal(err)
	}
	r := qt.ServerQueryV2{Version: 2, Profile: qt.SQLiteExpressionProfile, WireQuery: qt.WireQuery{Select: []string{"stamp"}, OrderBy: q.OrderBy, Limit: 1}}
	if _, err := d.ExecuteV2(context.Background(), db, &r, nil, qt.PlanOptions{}); err == nil {
		t.Fatal("invalid selected timestamp accepted")
	}
}

func TestV2RepeatedDistributionPayloads(t *testing.T) {
	db, d := setupReuse(t)
	for _, kind := range []string{"box", "histogram"} {
		t.Run(kind, func(t *testing.T) {
			spec := qt.AggSpec{ID: "original", GroupBy: []string{"flag"}, Distribution: &qt.MetricDistribution{Kind: kind, Input: "[n]", Bins: 2}}
			if kind == "box" {
				spec.Distribution.Bins = 0
			}
			q := metricV2("")
			q.Metrics = []qt.AggSpec{spec}
			metricProbeCalls.Store(0)
			original := runMetric(t, db, d, q)
			singleCalls := metricProbeCalls.Load()
			twin := spec
			twin.ID = "twin"
			q.Metrics = append(q.Metrics, twin)
			metricProbeCalls.Store(0)
			result, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if metricProbeCalls.Load() != singleCalls || singleCalls == 0 {
				t.Fatal("distribution repeated its scan")
			}
			copy := result.Metrics.Metrics[1]
			copy.ID = original.ID
			if !reflect.DeepEqual(copy, original) {
				t.Fatalf("memoized payload changed: %+v vs %+v", copy, original)
			}
			for i := range copy.Buckets {
				bucket := &copy.Buckets[i]
				bucket.Keys[0] = "mutated"
				*bucket.NullCount = 999
				*bucket.InputErrorCount = 999
				switch distribution := bucket.Distribution.(type) {
				case *qt.MetricHistogramDistribution:
					distribution.Edges[0] = 999
					distribution.Counts[0] = 999
				case *qt.MetricBoxDistribution:
					if distribution.Summary != nil {
						distribution.Summary.Mean = 999
					}
				}
			}
			if !reflect.DeepEqual(result.Metrics.Metrics[0], original) {
				t.Fatal("sibling distribution mutated")
			}
		})
	}
}
