package sqlitetests

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// benchmarkV3 builds a synthetic file database: rows source records spread
// over groups keys, with repeated n values (ties), NULLs and utc-millis
// datetimes. Like a typical host it uses a 32 MiB page cache and the default
// file-backed temp store. Run with, for example:
//
//	go test -run '^$' -bench V3 -benchmem -count 6
func benchmarkV3(b *testing.B, rows, groups int) (*sql.DB, qt.QueryDatasetV3) {
	b.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(b.TempDir(), "bench.db"))+"?_pragma=cache_size(-32768)")
	if err != nil {
		b.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	b.Cleanup(func() { db.Close() })
	_, err = db.Exec(fmt.Sprintf(`CREATE TABLE bench(id TEXT PRIMARY KEY,k TEXT,n REAL,at TEXT,label TEXT);
WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
INSERT INTO bench SELECT printf('%%08d',i),'group '||(i%%%d),CASE WHEN i%%50=0 THEN NULL ELSE (i*7919)%%1000 END,
 strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',1767225600+i*60,'unixepoch'),'label '||i FROM nums`, rows, groups))
	if err != nil {
		b.Fatal(err)
	}
	yes := true
	schema := qt.Schema{Name: "bench", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":    {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true},
		"k":     {Name: "k", Kind: qt.FieldText, Expr: "r.k", Sortable: true, ServerFilter: true},
		"n":     {Name: "n", Kind: qt.FieldNumber, Expr: "r.n", ExpressionNumeric: true, Sortable: true, ServerFilter: true, Groupable: &yes},
		"at":    {Name: "at", Kind: qt.FieldDatetime, Expr: "r.at", SQLiteDatetimeFormat: "utc-millis", Sortable: true, ServerFilter: true, Groupable: &yes},
		"label": {Name: "label", Kind: qt.FieldText, Expr: "r.label", Sortable: true, ServerFilter: true},
	}}
	return db, qt.QueryDatasetV3{Schema: schema, SourceSQL: "SELECT * FROM bench", Dialect: "sqlite", Scope: "bench", Dataset: "bench", MaxPopulation: rows, MaxGroups: groups}
}

func benchmarkV3Request(grouping *qt.GroupingDefinition, selected ...string) qt.QueryRequestV3 {
	return qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli(), Rows: true,
		Grouping: grouping,
		Result:   qt.WireQuery{Select: selected, OrderBy: qt.OrderBys{{Field: "k", Dir: "asc"}}, Limit: 100}}
}

func runV3Benchmark(b *testing.B, db *sql.DB, d qt.QueryDatasetV3, q qt.QueryRequestV3) {
	b.Helper()
	runBenchmark(b, func() {
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
			b.Fatal(err)
		}
	})
}

// runBenchmark also reports process CPU time (user+system) per operation,
// which is steadier than wall time on a shared machine.
func runBenchmark(b *testing.B, run func()) {
	b.Helper()
	run()
	cpu := func() time.Duration {
		var usage syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
			b.Fatal(err)
		}
		return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
	}
	b.ResetTimer()
	start := cpu()
	for i := 0; i < b.N; i++ {
		run()
	}
	b.ReportMetric(float64(cpu()-start)/float64(b.N), "cpu-ns/op")
}

// 100,000 rows in 1,000 groups; three ROW fields chosen by n DESC with ties.
func BenchmarkV3RepresentativeRows(b *testing.B) {
	db, d := benchmarkV3(b, 100000, 1000)
	runV3Benchmark(b, db, d, benchmarkV3Request(&qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{
		{ID: "num", Op: "count"}, {ID: "row_id", Op: "row", Field: "id"}, {ID: "row_label", Op: "row", Field: "label"}, {ID: "row_at", Op: "row", Field: "at"},
	}, Representative: &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: "last"}}}}, "k", "num", "row_id", "row_label", "row_at"))
}

// 100,000 rows in 1,000 groups; datetime extrema and ROW values, HAVING,
// sorting and result metrics all consume staged values.
func BenchmarkV3StagedValues(b *testing.B) {
	db, d := benchmarkV3(b, 100000, 1000)
	q := benchmarkV3Request(&qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{
		{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}, {ID: "first", Op: "min", Field: "at"}, {ID: "last", Op: "max", Field: "at"},
		{ID: "row_at", Op: "row", Field: "at"}, {ID: "row_label", Op: "row", Field: "label"},
	}, Representative: &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "at", Dir: "desc"}}}}, "k", "num", "total", "first", "last", "row_at", "row_label")
	q.Result.Where = []qt.WhereTerm{{Field: "num", Op: ">=", Value: "1"}}
	q.Result.OrderBy = qt.OrderBys{{Field: "first", Dir: "desc"}}
	q.Metrics = []qt.AggSpec{{ID: "latest", Op: "max", Field: "last"}, {ID: "total", Op: "sum", Field: "total"}, {ID: "by_label", Op: "count", GroupBy: []string{"row_label"}, GroupLimit: 10}}
	runV3Benchmark(b, db, d, q)
}
