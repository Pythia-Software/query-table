package sqlitetests

import (
	"context"
	"database/sql"
	"math"
	"path/filepath"
	"sort"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// gapPopulation stages rows request gaps every 0.3 s from midnight UTC,
// alternating between two models, so each (day, model) group of the first
// day holds more than the former 100,000-sample cap. Every 97th gap is NULL.
func gapPopulation(t *testing.T, rows int) (*sql.DB, qt.QueryDatasetV3) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "gaps.db")))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(`CREATE TABLE requests(id INTEGER PRIMARY KEY, model TEXT, at TEXT, gap REAL);
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<?1)
INSERT INTO requests SELECT i,CASE WHEN i%2=0 THEN 'opus' ELSE 'sonnet' END,
 strftime('%Y-%m-%dT%H:%M:%fZ',1767225600+i*0.3,'unixepoch'),
 CASE WHEN i%97=0 THEN NULL ELSE ((i*7919)%100003)/7.0 END FROM s`, rows); err != nil {
		t.Fatal(err)
	}
	yes := true
	schema := qt.Schema{Name: "requests", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":    {Name: "id", Kind: qt.FieldNumber, Expr: "r.id", ExpressionNumeric: true, Sortable: true},
		"model": {Name: "model", Kind: qt.FieldEnum, Expr: "r.model", Sortable: true, ServerFilter: true},
		"at":    {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", SQLiteDatetimeFormat: "rfc3339", Sortable: true, ServerFilter: true, Groupable: &yes},
		"gap":   {Name: "gap", Kind: qt.FieldNumber, Expr: "r.gap", ExpressionNumeric: true, Sortable: true},
	}}
	return db, qt.QueryDatasetV3{Dialect: "sqlite", Schema: schema, SourceSQL: "SELECT * FROM requests", MaxPopulation: rows}
}

// exactLinear is the documented percentile of sorted samples.
func exactLinear(sorted []float64, p float64) float64 {
	position := float64(len(sorted)-1) * p
	lower := math.Floor(position)
	fraction := position - lower
	a, b := sorted[int(lower)], sorted[min(int(lower)+1, len(sorted)-1)]
	return min(b, max(a, float64(float64(1-fraction)*a)+float64(fraction*b)))
}

// A calendar PERCENTILE by day and model over a large source runs without a
// sample budget, and several percentiles of one input share one ranking.
func TestCalendarPercentileByDayAndModel(t *testing.T) {
	// Each (day, model) group holds 110,000 samples, or 4,000 under the
	// race detector.
	rows := 220000
	if raceEnabled {
		rows = 8000
	}
	db, d := gapPopulation(t, rows)
	q := metricsV3(nil, nil, 0, 0, qt.AggSpec{
		ID: "p90", Expression: "PERCENTILE([gap], 0.9) - PERCENTILE([gap], 0.5)", GroupBy: []string{"at", "model"},
		DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "UTC", Range: "observed"},
	})
	r, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	m := r.Metrics[0]
	if m.Error != "" || len(m.Buckets) != 2 {
		t.Fatal(mustJSON(t, m))
	}
	for _, b := range m.Buckets {
		if b.Error != "" || b.Count != int64(rows/2) {
			t.Fatal(mustJSON(t, b))
		}
		values := []float64{}
		result, err := db.Query("SELECT gap FROM requests WHERE model=? AND gap IS NOT NULL", b.Keys[1])
		if err != nil {
			t.Fatal(err)
		}
		for result.Next() {
			var v float64
			if err = result.Scan(&v); err != nil {
				t.Fatal(err)
			}
			values = append(values, v)
		}
		result.Close()
		sort.Float64s(values)
		if want := exactLinear(values, 0.9) - exactLinear(values, 0.5); b.Value != want {
			t.Fatal(b.Keys, b.Value, want)
		}
	}
}

func TestPercentileFormulaErrors(t *testing.T) {
	db, d := setupV2(t)
	for _, c := range []struct{ expression, code string }{
		{"PERCENTILE([n])", "arity"},
		{"PERCENTILE([n], 0.5, 1)", "arity"},
		{"PERCENTILE([n], 1.5)", "type_error"},
		{"PERCENTILE([n], -0.5)", "type_error"},
		{"PERCENTILE([n], [n])", "type_error"},
		{"PERCENTILE([text], 0.5)", "type_error"},
	} {
		r, err := d.Execute(context.Background(), db, metricV2(c.expression), qt.PlanOptions{})
		if err != nil || r.Metrics[0].ErrorCode != qt.ErrorCode(c.code) {
			t.Fatal(c.expression, err, mustJSON(t, r.Metrics))
		}
	}
	// An invalid sample fails the reduction; an unused branch does not.
	for _, c := range []struct {
		expression string
		value      any
		code       string
	}{
		{"PERCENTILE([n]/0, 0.5)", nil, "divide_by_zero"},
		{"IF(TRUE, 1, PERCENTILE([n]/0, 0.5))", float64(1), ""},
		{"PERCENTILE([n], 0.25)", float64(3), ""},
	} {
		b := runMetric(t, db, d, metricV2(c.expression)).Buckets[0]
		if b.Value != c.value || b.Error != c.code {
			t.Fatal(c.expression, mustJSON(t, b))
		}
	}
}
