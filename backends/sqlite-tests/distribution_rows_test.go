package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func distributionSpecs() []qt.AggSpec {
	box := func(id, input string, groups ...string) qt.AggSpec {
		return qt.AggSpec{ID: id, GroupBy: groups, Distribution: &qt.MetricDistribution{Kind: "box", Input: input}}
	}
	histogram := func(id, input string, bins int, groups ...string) qt.AggSpec {
		return qt.AggSpec{ID: id, GroupBy: groups, Distribution: &qt.MetricDistribution{Kind: "histogram", Input: input, Bins: bins}}
	}
	tukey := box("tukey", "[n2]", "enum")
	tukey.Distribution.Whiskers = "tukey"
	limited := box("limited", "[n]", "text")
	limited.GroupLimit = 2
	limited.Sort = []qt.MetricSort{{Key: "samples", Dir: "desc"}}
	nullsFirst := box("nulls_first", "[n2]", "text", "flag")
	nullsFirst.Sort = []qt.MetricSort{{Key: "value", Dir: "asc", Nulls: "first"}}
	minimum := box("minimum", "[n]", "enum")
	minimum.MinCount = qt.MetricMinCount{Min: 14}
	filtered := histogram("filtered", "[n]", 3, "flag")
	filtered.Where = []qt.WhereTerm{{Field: "text", Op: "!=", Value: "red"}}
	filteredBox := box("filtered_box", "[n2]", "flag")
	filteredBox.Where = filtered.Where
	byCount := histogram("by_count", "[n2]", 2, "text")
	byCount.Sort = []qt.MetricSort{{Key: "count", Dir: "asc"}, {Key: "samples", Dir: "desc"}}
	byCount.GroupLimit = 4
	return []qt.AggSpec{
		box("box", "[n]"), box("grouped", "[n]", "enum"), box("pairs", "[n2]", "enum", "flag"), tukey, limited, nullsFirst, minimum,
		histogram("histogram", "[n]", 0), histogram("grouped_histogram", "[n2]", 30, "enum"), filtered, filteredBox, byCount,
		{ID: "count", Op: "count", GroupBy: []string{"enum"}},
		{ID: "sum", Op: "sum", Field: "n"},
	}
}

func TestRowsDistributionParity(t *testing.T) {
	s := rowsSchema()
	rows := rowsFixture()
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	specs := distributionSpecs()
	compare := func(q qt.MetricQuery) {
		t.Helper()
		compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
		compareDirect(t, tx, d, q)
	}
	for _, spec := range specs {
		compare(qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{spec}})
	}
	q := qt.MetricQuery{Version: 2, Metrics: specs}
	compare(q)
	// An empty population still has one ungrouped bucket.
	q.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "missing"}}
	compare(q)
	// One sample, and one repeated value: a degenerate histogram extent.
	q.Where = []qt.WhereTerm{{Field: "n", Op: "=", Value: "1.5"}}
	compare(q)
	q.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "r007"}}
	compare(q)
	d.MaxGroups = 3
	q.Where = nil
	compare(q)
	d.MaxGroups = 0
	// Source arguments precede table and metric filter parameters.
	d.SourceSQL, d.SourceArgs = "SELECT * FROM memory WHERE id <> ? AND id <> ?", []any{"r005", "r011"}
	q.Where = []qt.WhereTerm{{Field: "n2", Op: "!=", Value: "11"}}
	if r, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{}); err != nil || r.Metrics.Metrics[0].ProcessedRows == 0 {
		t.Fatal(r, err)
	}
	compareDirect(t, tx, d, q)
	d.MaxPopulation = 50
	if _, err := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{}); err == nil {
		t.Fatal("population budget ignored")
	}
	compareDirect(t, tx, d, q)
}

func TestRowsDistributionErrorParity(t *testing.T) {
	for name, values := range map[string][]any{
		"storage":         {int64(1), "bad", float64(2)},
		"range":           {1e101, int64(3), nil},
		"unsafe":          {int64(1 << 53), int64(1)},
		"least code":      {"bad", 1e101, int64(1 << 53)},
		"tiny":            {1e-301, 1e-300},
		"wide histogram":  {-1e100, 1e100},
		"precision":       {1.0, 1.0000000000000002},
		"negative zero":   {0.0, -1.5, int64(0), 2.5},
		"nulls only":      {nil, nil},
		"integer samples": {int64(9007199254740991), int64(-9007199254740991), int64(5)},
		// Mean roundoff must not leave the observed range.
		"boundary mean": func() []any {
			values := make([]any, 55)
			for i := range values {
				values[i] = 1e-300
			}
			return values
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			s := rowsSchema()
			rows := make([]map[string]any, 0, 2*len(values))
			for i, v := range values {
				// The error and its group appear in only one of two groups.
				rows = append(rows, map[string]any{"id": fmt.Sprint(i), "n": v, "n2": int64(i), "enum": "a"})
				rows = append(rows, map[string]any{"id": fmt.Sprint("b", i), "n": int64(i), "n2": v, "enum": "b"})
			}
			db := openRowsDB(t)
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			stageMemoryRows(t, tx, s, rows)
			d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
			q := qt.MetricQuery{Version: 2}
			for _, kind := range []string{"box", "histogram"} {
				for _, field := range []string{"n", "n2"} {
					for _, groups := range [][]string{nil, {"enum"}} {
						spec := qt.AggSpec{ID: fmt.Sprint(kind, field, len(groups)), GroupBy: groups, Distribution: &qt.MetricDistribution{Kind: kind, Input: "[" + field + "]"}}
						if kind == "box" && len(groups) > 0 {
							spec.Distribution.Whiskers = "tukey"
						}
						q.Metrics = append(q.Metrics, spec)
					}
				}
			}
			compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
			compareDirect(t, tx, d, q)
		})
	}
}

func TestRowsDistributionBoxSampleBudget(t *testing.T) {
	s := rowsSchema()
	rows := make([]map[string]any, qt.SQLiteMaxBoxSamples+1)
	for i := range rows {
		rows[i] = map[string]any{"id": fmt.Sprint(i), "n": int64(i % 1000), "enum": fmt.Sprint(i % 2)}
	}
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory", MaxPopulation: len(rows)}
	q := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{
		{ID: "box", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
		{ID: "grouped", GroupBy: []string{"enum"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
		{ID: "histogram", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n]"}},
	}}
	compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
	compareDirect(t, tx, d, q)
	got, err := qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{})
	if err != nil || got.Metrics.Metrics[0].Buckets[0].Error != "resource_limit" || got.Metrics.Metrics[1].Buckets[0].Error != "" {
		t.Fatal(got, err)
	}
}

func TestRowsDistributionFallbacks(t *testing.T) {
	s := rowsSchema()
	rows := rowsFixture()
	d := qt.SQLiteV2Dataset{Schema: s}
	for _, spec := range []qt.AggSpec{
		{ID: "formula", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]*2"}},
		{ID: "shown", Scope: "shownRows", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
		{ID: "computed", GroupBy: []string{"enum"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}, Where: []qt.WhereTerm{{Field: "@computed/x", Op: "=", Value: "1"}}},
	} {
		q := qt.MetricQuery{Version: 2, Limit: 10, Metrics: []qt.AggSpec{spec}}
		if _, err := qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{}); !errors.Is(err, qt.ErrRowsUnsupported) {
			t.Fatal(spec.ID, err)
		}
	}
	// Invalid clauses fail the metric, not the request.
	q := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{{ID: "text", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[text]"}}}}
	got, err := qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{})
	if err != nil || got.Metrics.Metrics[0].Error == "" {
		t.Fatal(got, err)
	}
}

// compareDirect compares the direct SQLite distribution path with compiled
// plans: "[field]*1" has the same samples and errors but is a formula.
func compareDirect(tb testing.TB, tx *sql.Tx, d qt.SQLiteV2Dataset, q qt.MetricQuery) {
	tb.Helper()
	compiled := q
	compiled.Metrics = append([]qt.AggSpec{}, q.Metrics...)
	for i, spec := range compiled.Metrics {
		if spec.Distribution != nil {
			distribution := *spec.Distribution
			distribution.Input += "*1"
			compiled.Metrics[i].Distribution = &distribution
		}
	}
	got, ge := d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
	want, we := d.ExecuteV2In(context.Background(), tx, nil, &compiled, qt.PlanOptions{})
	if ge != nil || we != nil {
		if fmt.Sprint(ge) != fmt.Sprint(we) {
			tb.Fatalf("errors: direct %v compiled %v", ge, we)
		}
		return
	}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		tb.Fatalf("query %+v\ndirect   %s\ncompiled %s", q, gb, wb)
	}
}

func TestDirectDistributionScanAndFallback(t *testing.T) {
	s := rowsSchema()
	rows := rowsFixture()
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	q := qt.MetricQuery{Version: 2, Metrics: distributionSpecs()[:12]}
	guards := sqliteCalls["qt_v2_field_error"]
	before := guards.Load()
	if _, err = d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	// Twelve metrics read the population once, natively, without guards.
	if calls := guards.Load() - before; calls != 0 {
		t.Fatal("direct distributions called field guards", calls)
	}
	compareDirect(t, tx, d, q)
	// Storage the reducers cannot read exactly retains compiled plans.
	for _, update := range []string{
		"UPDATE memory SET n=x'01' WHERE id='r001'",
		"UPDATE memory SET flag=2 WHERE id='r002'",
		"UPDATE memory SET text='a'||char(0)||'b' WHERE id='r003'",
	} {
		if _, err = tx.Exec("SAVEPOINT storage"); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(update); err != nil {
			t.Fatal(err)
		}
		before = guards.Load()
		if _, err = d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{}); err != nil {
			t.Fatal(err)
		}
		if guards.Load() == before {
			t.Fatal("fallback did not use compiled plans", update)
		}
		compareDirect(t, tx, d, q)
		if _, err = tx.Exec("ROLLBACK TO storage"); err != nil {
			t.Fatal(err)
		}
	}
}

// One native scan serves every direct distribution and, when proofs defer the
// population count, also counts it.
func TestDirectDistributionSharedScan(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	d := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
	where := []qt.WhereTerm{{Field: "n0", Op: ">", Value: "5"}}
	var matching int64
	if err := db.QueryRow("SELECT COUNT(*) FROM source WHERE tenant='allowed' AND n0>5").Scan(&matching); err != nil {
		t.Fatal(err)
	}
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Where: where, Metrics: []qt.AggSpec{
		{ID: "box", GroupBy: []string{"k"}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n1]"}},
		{ID: "histogram", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n2]"}},
		{ID: "filtered", GroupBy: []string{"k"}, Where: []qt.WhereTerm{{Field: "n3", Op: "<", Value: "20"}}, Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n1]", Whiskers: "tukey"}},
	}}
	// Warm the generation's whole-source proofs, which defer the count.
	warm := proofQuery(true)
	if _, err := d.ExecuteV2(context.Background(), db, nil, &warm, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	log.reset(nil)
	got, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if log.count("WITH qt_direct_source") != 1 || log.count(populationMarker) != 0 || log.count("WITH qt0") != 0 {
		t.Fatal("expected one shared scan", log.seen)
	}
	for _, m := range got.Metrics.Metrics {
		if m.Error != "" || m.ProcessedRows != matching || len(m.Buckets) == 0 || m.Buckets[0].Distribution == nil {
			t.Fatal(m)
		}
	}
}
