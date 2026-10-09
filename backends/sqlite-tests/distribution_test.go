package sqlitetests

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func distributionQuery(kind, input string) qt.MetricQuery {
	q := metricV2("")
	q.Metrics[0].Distribution = &qt.MetricDistribution{Kind: kind, Input: input}
	return q
}
func TestSQLiteBoxDistribution(t *testing.T) {
	db, d := setupV2(t)
	q := distributionQuery("box", "[n]")
	m := runMetric(t, db, d, q)
	b := m.Buckets[0]
	s := b.Distribution.(*qt.MetricBoxDistribution).Summary
	want := &qt.MetricBoxSummary{N: 3, Min: 2, Q1: 3, Median: 4, Q3: 5, Max: 6, Mean: 4, Low: 2, High: 6, Outliers: []float64{}, Whiskers: "minmax", Method: "exact-linear"}
	if !reflect.DeepEqual(s, want) || b.Value != float64(4) || b.Count != 4 || *b.NullCount != 1 || *b.InputErrorCount != 0 || b.Error != "" {
		t.Fatalf("%#v %#v", b, s)
	}
	q.Metrics[0].GroupBy = []string{"flag"}
	q.Metrics[0].GroupLimit = 1
	q.Metrics[0].Sort = []qt.MetricSort{{Key: "samples", Dir: "desc"}}
	m = runMetric(t, db, d, q)
	if m.GroupCount != 3 || len(m.Buckets) != 1 || m.Buckets[0].Keys[0] != true || m.Buckets[0].Distribution.(*qt.MetricBoxDistribution).Summary.N != 2 {
		t.Fatal(m)
	}
	q = distributionQuery("box", "[n]+1")
	q.Limit = 2
	q.Offset = 1
	q.OrderBy = []qt.OrderBy{{Field: "n", Dir: "desc"}}
	q.Metrics[0].Scope = "shownRows"
	m = runMetric(t, db, d, q)
	if m.ProcessedRows != 2 || m.Buckets[0].Value != float64(4) {
		t.Fatal(m)
	}
}
func TestSQLiteHistogramDistribution(t *testing.T) {
	db, d := setupV2(t)
	q := distributionQuery("histogram", "[n]")
	q.Metrics[0].Distribution.Bins = 2
	q.Metrics[0].GroupBy = []string{"flag"}
	m := runMetric(t, db, d, q)
	for _, b := range m.Buckets {
		h := b.Distribution.(*qt.MetricHistogramDistribution)
		if !reflect.DeepEqual(h.Edges, []float64{2, 4, 6}) {
			t.Fatal(h)
		}
		if b.Keys[0] == true && !reflect.DeepEqual(h.Counts, []int64{1, 1}) || b.Keys[0] == false && !reflect.DeepEqual(h.Counts, []int64{0, 1}) || b.Keys[0] == nil && !reflect.DeepEqual(h.Counts, []int64{0, 0}) {
			t.Fatal(b)
		}
	}
	q.Metrics[0].GroupLimit = 1
	q.Metrics[0].Sort = []qt.MetricSort{{Key: "group0", Dir: "asc"}}
	m = runMetric(t, db, d, q)
	if m.GroupCount != 3 || m.Buckets[0].Keys[0] != false || !reflect.DeepEqual(m.Buckets[0].Distribution.(*qt.MetricHistogramDistribution).Edges, []float64{2, 4, 6}) {
		t.Fatal(m)
	}
	q = distributionQuery("histogram", "[n]")
	q.Limit = 2
	q.Offset = 1
	q.OrderBy = []qt.OrderBy{{Field: "n", Dir: "desc"}}
	q.Metrics[0].Scope = "shownRows"
	q.Metrics[0].Distribution.Bins = 2
	m = runMetric(t, db, d, q)
	h := m.Buckets[0].Distribution.(*qt.MetricHistogramDistribution)
	if !reflect.DeepEqual(h.Edges, []float64{2, 3, 4}) || !reflect.DeepEqual(h.Counts, []int64{1, 1}) || m.ProcessedRows != 2 {
		t.Fatal(m)
	}
}
func TestSQLiteDistributionEmptyNullAndConstant(t *testing.T) {
	db, d := setupV2(t)
	for _, kind := range []string{"box", "histogram"} {
		for _, predicate := range []qt.WhereTerm{{Field: "id", Op: "=", Value: "missing"}, {Field: "id", Op: "=", Value: "c"}, {Field: "id", Op: "=", Value: "b"}} {
			q := distributionQuery(kind, "[n]")
			q.Where = []qt.WhereTerm{predicate}
			m := runMetric(t, db, d, q)
			b := m.Buckets[0]
			if b.Error != "" {
				t.Fatal(b)
			}
			if predicate.Value == "b" {
				if kind == "box" {
					s := b.Distribution.(*qt.MetricBoxDistribution).Summary
					if s.Q1 != 4 || s.Q3 != 4 || s.Low != 4 || s.High != 4 {
						t.Fatal(s)
					}
				} else {
					h := b.Distribution.(*qt.MetricHistogramDistribution)
					if !reflect.DeepEqual(h.Edges, []float64{4, 4}) || !reflect.DeepEqual(h.Counts, []int64{1}) {
						t.Fatal(h)
					}
				}
			} else {
				if kind == "box" {
					if b.Distribution.(*qt.MetricBoxDistribution).Summary != nil {
						t.Fatal(b)
					}
				} else {
					h := b.Distribution.(*qt.MetricHistogramDistribution)
					if len(h.Edges) != 0 || len(h.Counts) != 0 || h.N != 0 {
						t.Fatal(h)
					}
					body, e := json.Marshal(h)
					if e != nil || string(body) != `{"kind":"histogram","edges":[],"counts":[],"n":0}` {
						t.Fatal(string(body), e)
					}
				}
			}
		}
		q := distributionQuery(kind, "[n]")
		q.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "missing"}}
		q.Metrics[0].GroupBy = []string{"flag"}
		m := runMetric(t, db, d, q)
		if len(m.Buckets) != 0 || m.GroupCount != 0 {
			t.Fatal(m)
		}
	}
}
func TestSQLiteDistributionErrorsAndBudgets(t *testing.T) {
	db, d := setupV2(t)
	for _, kind := range []string{"box", "histogram"} {
		q := distributionQuery(kind, "[n]/0")
		m := runMetric(t, db, d, q)
		b := m.Buckets[0]
		if b.Error != "divide_by_zero" || b.Value != nil || b.Distribution != nil || *b.InputErrorCount != 3 || *b.NullCount != 1 {
			t.Fatal(b)
		}
		q = distributionQuery(kind, "[n]")
		q.Metrics[0].GroupBy = []string{"flag"}
		d.MaxGroups = 2
		q.Metrics[0].GroupLimit = 1
		if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
			t.Fatal("group budget ignored")
		}
		d.MaxGroups = 0
	}
	q := distributionQuery("box", "[n]")
	d.SourceSQL = "WITH RECURSIVE samples(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM samples WHERE n<100001) SELECT n,CAST(n AS TEXT) AS id FROM samples"
	d.SourceArgs = nil
	d.Schema.Fields = map[string]qt.FieldSpec{"id": d.Schema.Fields["id"], "n": d.Schema.Fields["n"]}
	m := runMetric(t, db, d, q)
	if m.Buckets[0].Error != "resource_limit" || m.Buckets[0].Distribution != nil {
		t.Fatal(m)
	}
	// Histograms retain only counters, so the same population remains exact.
	q = distributionQuery("histogram", "[n]")
	m = runMetric(t, db, d, q)
	h := m.Buckets[0].Distribution.(*qt.MetricHistogramDistribution)
	var total int64
	for _, n := range h.Counts {
		total += n
	}
	if total != 100001 || h.N != 100001 {
		t.Fatal(h)
	}
}
func TestSQLiteDistributionValidation(t *testing.T) {
	db, d := setupV2(t)
	for _, change := range []func(*qt.MetricQuery){func(q *qt.MetricQuery) { q.Metrics[0].Distribution.Kind = "unknown" }, func(q *qt.MetricQuery) { q.Metrics[0].Distribution.Input = "SUM([n])" }, func(q *qt.MetricQuery) { q.Metrics[0].Distribution.Input = "[text]" }, func(q *qt.MetricQuery) { q.Metrics[0].Distribution.Bins = 31 }, func(q *qt.MetricQuery) { q.Metrics[0].Distribution.Whiskers = "other" }, func(q *qt.MetricQuery) { q.Metrics[0].ExpressionY = "COUNT()" }, func(q *qt.MetricQuery) { q.Metrics[0].GroupBy = []string{"flag", "text"} }} {
		q := distributionQuery("histogram", "[n]")
		change(&q)
		if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
			t.Fatal(q)
		}
	}
	f := d.Schema.Fields["n"]
	f.AggregateOps = []string{}
	d.Schema.Fields["n"] = f
	q := distributionQuery("box", "[n]")
	if _, e := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); e == nil {
		t.Fatal("disabled measure accepted")
	}
}

func TestSQLiteDistributionNumericPrecision(t *testing.T) {
	db, d := setupV2(t)
	d.Schema.Fields = map[string]qt.FieldSpec{"id": d.Schema.Fields["id"], "n": d.Schema.Fields["n"]}
	d.SourceArgs = nil
	for _, c := range []struct{ source, input, code string }{{"SELECT 1 AS n,'a' AS id UNION ALL SELECT 1.0000000000000002,'b'", "[n]", "histogram_precision"}, {"SELECT 9007199254740992 AS n,'a' AS id", "[n]", "unsafe_integer"}, {"SELECT 1 AS n,'a' AS id", "[n]/0", "divide_by_zero"}} {
		d.SourceSQL = c.source
		for _, kind := range []string{"box", "histogram"} {
			if c.code == "histogram_precision" && kind == "box" {
				continue
			}
			q := distributionQuery(kind, c.input)
			m := runMetric(t, db, d, q)
			if m.Buckets[0].Error != c.code || m.Buckets[0].Distribution != nil {
				t.Fatal(c, m)
			}
		}
	}
}
func TestSQLiteDistributionComputedAndSnapshot(t *testing.T) {
	db, d := setupV2(t)
	ctx := context.Background()
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	def := qt.ComputedColumn{ID: "shift", Label: "Shift", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]+10"}}
	if _, e := store.Save(ctx, "one", "runs", qt.SaveComputedColumnRequest{Column: def}); e != nil {
		t.Fatal(e)
	}
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	handshake, e := d.DescribeComputedIn(ctx, tx, []string{"shift"}, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	q := distributionQuery("box", "[@computed/shift]")
	q.ExpectedRevisions = handshake.ResolvedRevisions
	q.Metrics = append(q.Metrics, qt.AggSpec{ID: "h", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[@computed/shift]", Bins: 2}})
	if _, e = db.Exec("UPDATE runs SET n=100 WHERE id='a'"); e != nil {
		t.Fatal(e)
	}
	r, e := d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{})
	if e != nil {
		t.Fatal(e)
	}
	s := r.Metrics.Metrics[0].Buckets[0].Distribution.(*qt.MetricBoxDistribution).Summary
	h := r.Metrics.Metrics[1].Buckets[0].Distribution.(*qt.MetricHistogramDistribution)
	if s.Min != 12 || s.Median != 14 || s.Max != 16 || !reflect.DeepEqual(h.Edges, []float64{12, 14, 16}) {
		t.Fatal(s, h)
	}
	q.ExpectedRevisions = map[string]string{"shift": "wrong"}
	if _, e = d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); e == nil {
		t.Fatal("stale computed revision accepted")
	}
	f := d.Schema.Fields["n"]
	f.AggregateOps = []string{}
	d.Schema.Fields["n"] = f
	q.ExpectedRevisions = handshake.ResolvedRevisions
	if _, e = d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); e == nil {
		t.Fatal("transitive disabled measure accepted")
	}
}
func TestSQLiteHistogramGlobalErrorBeforeTopN(t *testing.T) {
	db, d := setupV2(t)
	if _, e := db.Exec("UPDATE runs SET n='invalid' WHERE id='b'"); e != nil {
		t.Fatal(e)
	}
	q := distributionQuery("histogram", "[n]")
	q.Metrics[0].GroupBy = []string{"flag"}
	q.Metrics[0].GroupLimit = 1
	q.Metrics[0].Sort = []qt.MetricSort{{Key: "group0", Dir: "desc"}}
	m := runMetric(t, db, d, q)
	if m.GroupCount != 3 || m.Buckets[0].Error != "storage_type" || m.Buckets[0].Distribution != nil {
		t.Fatal(m)
	}
	q.Metrics[0].Distribution.Kind = "box"
	m = runMetric(t, db, d, q)
	if m.Buckets[0].Keys[0] != true || m.Buckets[0].Error != "" || m.Buckets[0].Distribution.(*qt.MetricBoxDistribution).Summary.Median != 4 {
		t.Fatal(m)
	}
}

// This fixture is consumed by distribution-parity.test.ts to compare actual
// SQLite plans, UDFs and response decoding with the core renderer algorithms.
func TestSQLiteDistributionFrontendParity(t *testing.T) {
	db, d := setupV2(t)
	d.Schema.Fields = map[string]qt.FieldSpec{"id": d.Schema.Fields["id"], "n": d.Schema.Fields["n"]}
	samples := [][]float64{{}, {4}, {1, 2, 3, 100}, {0.1, 0.2, 0.3, 1}, {-7, -2, 0, 3, 9}, {1, 1.0000000000000002}, {1e-300, 2e-300, 3e-300, 4e-300}, {-9007199254740991, 9007199254740991}}
	tails := []float64{}
	for i := 0; i < 30; i++ {
		tails = append(tails, float64(-100-i))
	}
	for i := 0; i < 200; i++ {
		tails = append(tails, 0)
	}
	for i := 0; i < 30; i++ {
		tails = append(tails, float64(100+i))
	}
	samples = append(samples, tails)
	type fixture struct {
		Samples  []float64               `json:"samples"`
		Kind     string                  `json:"kind"`
		Whiskers string                  `json:"whiskers"`
		Bins     int                     `json:"bins"`
		Bucket   qt.SQLiteMetricV2Bucket `json:"bucket"`
	}
	fixtures := []fixture{}
	for _, values := range samples {
		d.SourceArgs = []any{}
		parts := []string{}
		for i, v := range values {
			d.SourceArgs = append(d.SourceArgs, v)
			parts = append(parts, fmt.Sprintf("SELECT ?%d AS n,'%d' AS id", i+1, i))
		}
		if len(parts) == 0 {
			d.SourceSQL = "SELECT NULL AS n,'empty' AS id WHERE 0"
		} else {
			d.SourceSQL = strings.Join(parts, " UNION ALL ")
		}
		for _, kind := range []string{"box", "histogram"} {
			for _, mode := range []string{"minmax", "tukey"} {
				if kind == "histogram" && mode == "tukey" {
					continue
				}
				q := distributionQuery(kind, "[n]")
				q.Metrics[0].Distribution.Whiskers = mode
				q.Metrics[0].Distribution.Bins = 10
				m := runMetric(t, db, d, q)
				fixtures = append(fixtures, fixture{values, kind, mode, 10, m.Buckets[0]})
			}
		}
	}
	body, e := json.Marshal(fixtures)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("DISTRIBUTION_FIXTURES %s", body)
}
