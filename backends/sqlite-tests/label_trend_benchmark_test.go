package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime/pprof"
	"strconv"
	"syscall"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Synthetic, immutable observations: two overlapping labels per message.
// Setup and native reference checks are outside the execution timer.
func labelTrendFixture(tb testing.TB, messages int) (*sql.DB, qt.QueryDatasetV3, qt.QueryRequestV3) {
	tb.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		tb.Fatal(err)
	}
	return labelTrendFixtureWithDB(tb, messages, db)
}

func labelTrendFixtureWithDB(tb testing.TB, messages int, db *sql.DB) (*sql.DB, qt.QueryDatasetV3, qt.QueryRequestV3) {
	tb.Helper()
	db.SetMaxOpenConns(1)
	tb.Cleanup(func() { db.Close() })
	_, err := db.Exec(fmt.Sprintf(`PRAGMA temp_store=MEMORY;
 CREATE TABLE observations(id TEXT PRIMARY KEY,message_id TEXT,day TEXT,family TEXT,occurred_at TEXT);
 WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<%d), labels(j) AS (VALUES(0),(1))
 INSERT INTO observations SELECT printf('%%064d:%%d',i,j),printf('%%064d',i),date('2026-08-13','+'||(i%%90)||' days'),
 'P.family'||((i+j)%%12),strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','2026-08-13','+'||(i%%90)||' days') FROM n CROSS JOIN labels;
 CREATE INDEX observation_time ON observations(occurred_at,day,message_id,family);`, messages))
	if err != nil {
		tb.Fatal(err)
	}
	yes := true
	fields := map[string]qt.FieldSpec{}
	for _, name := range []string{"id", "message_id", "day", "family", "occurred_at"} {
		f := qt.FieldSpec{Name: name, Kind: qt.FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true, Groupable: &yes}
		if name == "occurred_at" {
			f.Kind = qt.FieldDatetime
			f.SQLiteDatetimeFormat = "rfc3339"
		}
		fields[name] = f
	}
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: qt.Schema{Name: "observations", IDField: "id", Fields: fields, DefaultSort: []qt.OrderBy{{Field: "occurred_at", Dir: "desc", Nulls: "last"}}, TiebreakSort: []qt.OrderBy{{Field: "id", Dir: "asc"}}}, SourceSQL: "SELECT id,message_id,day,family,occurred_at FROM observations", MaxRows: 10000, MaxGroups: 100000, MaxPopulation: 10000000, MaxStagingBytes: 512 << 20}
	q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: 1794362816119, Rows: false, Source: qt.WireQuery{Select: []string{"id"}, Limit: 100}, Result: qt.WireQuery{Select: []string{"id"}, Limit: 100, Where: []qt.WhereTerm{{Field: "occurred_at", Op: "<", Value: "+0s"}, {Field: "occurred_at", Op: ">=", Value: "2026-08-06T00:00:00-06:00"}}}, Metrics: []qt.AggSpec{{ID: "trend", Op: "count_distinct", Field: "message_id", GroupBy: []string{"day", "family"}}, {ID: "trend:population", Op: "count_distinct", Field: "message_id", GroupBy: []string{"day"}}}}
	return db, d, q
}

func labelTrendNative(tb testing.TB, db *sql.DB, q qt.QueryRequestV3) []map[string]int64 {
	tb.Helper()
	out := []map[string]int64{}
	lower, err := time.Parse(time.RFC3339, q.Result.Where[1].Value)
	if err != nil {
		tb.Fatal(err)
	}
	for _, by := range []string{"day,family", "day"} {
		start := time.Now()
		rows, err := db.Query("SELECT "+by+",COUNT(DISTINCT message_id COLLATE BINARY) FROM observations WHERE qt_datetime(occurred_at)<? AND qt_datetime(occurred_at)>=? GROUP BY "+by, time.UnixMilli(q.Now).UTC().Format("2006-01-02T15:04:05.000000000Z"), lower.UTC().Format("2006-01-02T15:04:05.000000000Z"))
		if err != nil {
			tb.Fatal(err)
		}
		counts := map[string]int64{}
		for rows.Next() {
			var day, family string
			var n int64
			keys := []any{}
			if by == "day" {
				err = rows.Scan(&day, &n)
				keys = []any{day}
			} else {
				err = rows.Scan(&day, &family, &n)
				keys = []any{day, family}
			}
			if err != nil {
				tb.Fatal(err)
			}
			key, _ := json.Marshal(keys)
			counts[string(key)] = n
		}
		if err = rows.Err(); err != nil {
			tb.Fatal(err)
		}
		rows.Close()
		out = append(out, counts)
		tb.Logf("native %s: %s (%d buckets)", by, time.Since(start), len(counts))
	}
	return out
}
func checkLabelTrend(tb testing.TB, got qt.QueryResultV3, want []map[string]int64) {
	tb.Helper()
	if len(got.Metrics) != len(want) {
		tb.Fatal(got)
	}
	for i, m := range got.Metrics {
		if m.Error != "" {
			tb.Fatal(m.Error)
		}
		counts := map[string]int64{}
		for _, bucket := range m.Buckets {
			if bucket.Error != "" {
				tb.Fatal(bucket.Error)
			}
			key, _ := json.Marshal(bucket.Keys)
			counts[string(key)] = int64(bucket.Value.(float64))
		}
		if !reflect.DeepEqual(counts, want[i]) {
			tb.Fatalf("metric %s: bucket mismatch", m.ID)
		}
	}
}
func BenchmarkLabelTrend(b *testing.B) {
	messages := 486149
	if v := os.Getenv("QT_LABEL_MESSAGES"); v != "" {
		var err error
		messages, err = strconv.Atoi(v)
		if err != nil || messages < 1 {
			b.Fatal("invalid QT_LABEL_MESSAGES")
		}
	}
	for _, selective := range []bool{false, true} {
		b.Run(fmt.Sprintf("selective=%t", selective), func(b *testing.B) {
			db, d, q := labelTrendFixture(b, messages)
			if selective {
				q.Result.Where[1].Value = "2026-11-09T00:00:00Z"
			}
			// Native uses the same interval, with the selective lower bound changed.
			want := labelTrendNative(b, db, q)
			for _, c := range sqliteCalls {
				c.Store(0)
			}
			cpuTime := func() time.Duration {
				var usage syscall.Rusage
				if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
					b.Fatal(err)
				}
				return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
			}
			cpuTotal := time.Duration(0)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				start := time.Now()
				cpuStart := cpuTime()
				var got qt.QueryResultV3
				var err error
				pprof.Do(context.Background(), pprof.Labels("phase", "executor"), func(ctx context.Context) { got, err = d.Execute(ctx, db, q, qt.PlanOptions{}) })
				cpuElapsed := cpuTime() - cpuStart
				cpuTotal += cpuElapsed
				elapsed := time.Since(start)
				b.StopTimer()
				if err != nil {
					b.Fatal(err)
				}
				checkLabelTrend(b, got, want)
				b.Logf("execution %d: wall=%s cpu=%s (%d observations)", i+1, elapsed, cpuElapsed, got.Total)
				b.StartTimer()
			}
			b.StopTimer()
			b.ReportMetric(float64(cpuTotal)/float64(b.N), "cpu-ns/op")
			for _, name := range []string{"qt_datetime", "qt_v2_field_error", "qt_v2_datetime", "qt_v2_datetime_value"} {
				b.ReportMetric(float64(sqliteCalls[name].Load())/float64(b.N), name+"/op")
			}
		})
	}
}

// Eighteen top-N/sort consumers of one reduction plus an independent day-only
// denominator. This catches repeated expensive grouping within a mixed batch.
func BenchmarkLabelTrendMixed(b *testing.B) {
	db, d, q := labelTrendFixture(b, 20000)
	want := labelTrendNative(b, db, q)
	detail, denominator := q.Metrics[0], q.Metrics[1]
	q.Metrics = nil
	for i := 0; i < 18; i++ {
		spec := detail
		spec.ID = fmt.Sprintf("variant-%d", i)
		spec.GroupLimit = i + 1
		spec.Sort = []qt.MetricSort{{Key: "value", Dir: []string{"asc", "desc"}[i%2]}}
		q.Metrics = append(q.Metrics, spec)
	}
	q.Metrics = append(q.Metrics, denominator)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		start := time.Now()
		got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		elapsed := time.Since(start)
		b.StopTimer()
		if err != nil {
			b.Fatal(err)
		}
		if got.Total != 40000 || len(got.Metrics) != 19 {
			b.Fatal("wrong population or metric count")
		}
		for j, m := range got.Metrics {
			ref := want[0]
			if j == 18 {
				ref = want[1]
			}
			if m.Error != "" || m.GroupCount != int64(len(ref)) || len(m.Buckets) == 0 {
				b.Fatal("incorrect mixed result", m)
			}
			for _, bucket := range m.Buckets {
				key, _ := json.Marshal(bucket.Keys)
				n, ok := ref[string(key)]
				if !ok || bucket.Error != "" || bucket.Value != float64(n) {
					b.Fatal("mixed bucket differs from native", bucket)
				}
			}
		}
		b.Logf("execution %d: %s (40000 observations, 19 metrics)", i+1, elapsed)
		b.StartTimer()
	}
}
