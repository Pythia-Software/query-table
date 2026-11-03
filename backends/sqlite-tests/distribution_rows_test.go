package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func distributionSpecs() []qt.AggSpec {
	box := func(id, input string, groups ...string) qt.AggSpec {
		return qt.AggSpec{ID: id, GroupBy: groups, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: input}}
	}
	histogram := func(id, input string, bins int, groups ...string) qt.AggSpec {
		return qt.AggSpec{ID: id, GroupBy: groups, Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: input, Bins: bins}}
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	specs := distributionSpecs()
	compare := func(q qt.QueryRequestV3) {
		t.Helper()
		compareStaged(t, tx, d, q, qt.PlanOptions{})
		compareDirect(t, tx, d, q)
	}
	for _, spec := range specs {
		compare(metricsV3(nil, nil, 0, 0, []qt.AggSpec{spec}...))
	}
	q := metricsV3(nil, nil, 0, 0, specs...)
	compare(q)
	// An empty population still has one ungrouped bucket.
	q.Result.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "missing"}}
	compare(q)
	// One sample, and one repeated value: a degenerate histogram extent.
	q.Result.Where = []qt.WhereTerm{{Field: "n", Op: "=", Value: "1.5"}}
	compare(q)
	q.Result.Where = []qt.WhereTerm{{Field: "id", Op: "=", Value: "r007"}}
	compare(q)
	d.MaxGroups = 3
	q.Result.Where = nil
	compare(q)
	d.MaxGroups = 0
	// Source arguments precede table and metric filter parameters.
	d.SourceSQL, d.SourceArgs = "SELECT * FROM memory WHERE id <> ? AND id <> ?", []any{"r005", "r011"}
	q.Result.Where = []qt.WhereTerm{{Field: "n2", Op: "!=", Value: "11"}}
	if r, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{}); err != nil || r.Metrics[0].ProcessedRows == 0 {
		t.Fatal(r, err)
	}
	compareDirect(t, tx, d, q)
	d.MaxPopulation = 50
	// v3 applies MaxPopulation to staged execution only.
	if _, err := qt.TestOnlyStageUngrouped(d).ExecuteIn(context.Background(), tx, q, qt.PlanOptions{}); err == nil {
		t.Fatal("population budget ignored")
	}
	assertStagedPopulationBudget(t, tx, d, q, qt.PlanOptions{})
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
			d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
			q := metricsV3(nil, nil, 0, 0)
			for _, kind := range []string{"box", "histogram"} {
				for _, field := range []string{"n", "n2"} {
					for _, groups := range [][]string{nil, {"enum"}} {
						spec := qt.AggSpec{ID: fmt.Sprint(kind, field, len(groups)), GroupBy: groups, Op: "count", Distribution: &qt.MetricDistribution{Kind: kind, Input: "[" + field + "]"}}
						if kind == "box" && len(groups) > 0 {
							spec.Distribution.Whiskers = "tukey"
						}
						q.Metrics = append(q.Metrics, spec)
					}
				}
			}
			compareStaged(t, tx, d, q, qt.PlanOptions{})
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory", MaxPopulation: len(rows)}
	q := metricsV3(nil, nil, 0, 0,
		qt.AggSpec{ID: "box", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
		qt.AggSpec{ID: "grouped", GroupBy: []string{"enum"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n]"}},
		qt.AggSpec{ID: "histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n]"}},
	)
	compareStaged(t, tx, d, q, qt.PlanOptions{})
	compareDirect(t, tx, d, q)
	got := executeV3Tx(t, tx, d, q, qt.PlanOptions{})
	// v3 checks MaxSamplesPerGroup (default 100000) before reducing and fails
	// the over-budget metric; v2 reported resource_limit on its bucket.
	if got.Metrics[0].Error != "The box distribution exceeded the 100,000-sample budget" || got.Metrics[1].Error != "" || got.Metrics[1].Buckets[0].Error != "" {
		t.Fatal(mustJSON(t, got.Metrics))
	}
}

func TestRowsDistributionFallbacks(t *testing.T) {
	s := rowsSchema()
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rowsFixture())
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	// Invalid clauses fail the metric, not the request.
	q := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "text", Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[text]"}})
	got, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
	if err != nil || got.Metrics[0].Error == "" {
		t.Fatal(got, err)
	}
}

// compareDirect compares the direct SQLite distribution path with compiled
// plans: "[field]*1" has the same samples and errors but is a formula.
func compareDirect(tb testing.TB, tx *sql.Tx, d qt.QueryDatasetV3, q qt.QueryRequestV3) {
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
	got, ge := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
	want, we := d.ExecuteIn(context.Background(), tx, compiled, qt.PlanOptions{})
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
	log := &statementLog{}
	db := hookedDB(t, log, "SELECT 1")
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	q := metricsV3(nil, nil, 0, 0, distributionSpecs()[:12]...)
	guards := sqliteCalls["qt_v2_field_error"]
	// v3 also sends a population COUNT and a compiled sample-budget probe per
	// distribution, which call field guards; attribute guard calls to the
	// statement that ran them (the connection runs one statement at a time).
	type statement struct {
		sql    string
		guards int64
	}
	var statements []statement
	// execute returns the guard calls of each direct scan, and those of the
	// statements after the last one (compiled fallback plans).
	execute := func() (direct []int64, after int64) {
		t.Helper()
		statements = nil
		log.reset(func(query string) error {
			statements = append(statements, statement{query, guards.Load()})
			return nil
		})
		if _, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{}); err != nil {
			t.Fatal(err)
		}
		end := guards.Load()
		log.reset(nil)
		for i, s := range statements {
			if strings.HasPrefix(s.sql, "WITH qt_direct_source") {
				next := end
				if i+1 < len(statements) {
					next = statements[i+1].guards
				}
				direct, after = append(direct, next-s.guards), end-next
			}
		}
		return direct, after
	}
	// Twelve metrics read the population once, natively, without guards.
	if direct, after := execute(); len(direct) != 1 || direct[0] != 0 || after != 0 {
		t.Fatal("direct distributions: scans and their guard calls", direct, after)
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
		// The direct scan declines; compiled plans after it call guards.
		if direct, after := execute(); len(direct) != 1 || after == 0 {
			t.Fatal("fallback did not use compiled plans", update, direct, after)
		}
		compareDirect(t, tx, d, q)
		if _, err = tx.Exec("ROLLBACK TO storage"); err != nil {
			t.Fatal(err)
		}
	}
}

// One native scan serves every direct distribution. v3 counts the population
// with its own statement first (v2's cached source proofs could defer it).
func TestDirectDistributionSharedScan(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	where := []qt.WhereTerm{{Field: "n0", Op: ">", Value: "5"}}
	var matching int64
	if err := db.QueryRow("SELECT COUNT(*) FROM source WHERE tenant='allowed' AND n0>5").Scan(&matching); err != nil {
		t.Fatal(err)
	}
	q := metricsV3(where, nil, 0, 0,
		qt.AggSpec{ID: "box", GroupBy: []string{"k"}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n1]"}},
		qt.AggSpec{ID: "histogram", Op: "count", Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[n2]"}},
		qt.AggSpec{ID: "filtered", GroupBy: []string{"k"}, Where: []qt.WhereTerm{{Field: "n3", Op: "<", Value: "20"}}, Op: "count", Distribution: &qt.MetricDistribution{Kind: "box", Input: "[n1]", Whiskers: "tukey"}},
	)
	log.reset(nil)
	got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Besides the shared scan, v3 sends the population COUNT and one compiled
	// sample-budget probe per distribution (v2 did neither); no other plans.
	if log.count("WITH qt_direct_source") != 1 || log.count(populationMarker) != 1 || log.count("WITH qt0") != 1+len(q.Metrics) {
		t.Fatal("expected one population count and one shared scan", strings.Join(log.seen, "\n---\n"))
	}
	for _, m := range got.Metrics {
		if m.Error != "" || m.ProcessedRows != matching || len(m.Buckets) == 0 || m.Buckets[0].Distribution == nil {
			t.Fatal(m)
		}
	}
}
