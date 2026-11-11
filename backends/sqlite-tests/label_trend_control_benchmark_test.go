package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Alternate the retained legacy SQL fallback and the shared-input path on one
// immutable database in one process. The hook declines before executing new
// input DDL, so the control uses the ordinary v1.0.5 typed reduction statements.
// Both paths still count the population, validate fields and check all buckets.
// This complements (rather than replaces) the separate-version benchmark.
func BenchmarkLabelTrendAlternating(b *testing.B) {
	base, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		b.Fatal(err)
	}
	driver := base.Driver()
	base.Close()
	legacy := false
	db := sql.OpenDB(statementHookConnector{base: driver, dsn: ":memory:", hook: func(statement string) error {
		if legacy && strings.HasPrefix(statement, "CREATE TEMP TABLE") && strings.Contains(statement, "qt_text_distinct_input") {
			return errors.New("benchmark declines shared text input")
		}
		return nil
	}})
	db, d, q := labelTrendFixtureWithDB(b, 486149, db)
	want := labelTrendNative(b, db, q)
	cpu := func() time.Duration {
		var u syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &u); err != nil {
			b.Fatal(err)
		}
		return time.Duration(u.Utime.Nano() + u.Stime.Nano())
	}
	walls, cpus := [2]time.Duration{}, [2]time.Duration{}
	b.ResetTimer()
	b.StopTimer()
	for i := 0; i < b.N; i++ {
		order := []int{0, 1}
		if i%2 == 1 {
			order = []int{1, 0}
		}
		for _, mode := range order {
			legacy = mode == 0
			b.StartTimer()
			start, firstCPU := time.Now(), cpu()
			got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			elapsed, usedCPU := time.Since(start), cpu()-firstCPU
			b.StopTimer()
			if err != nil {
				b.Fatal(err)
			}
			checkLabelTrend(b, got, want)
			if got.Total != 972298 {
				b.Fatal("wrong population")
			}
			walls[mode] += elapsed
			cpus[mode] += usedCPU
			b.Logf("pair %d %s: wall=%s cpu=%s", i+1, []string{"legacy", "shared"}[mode], elapsed, usedCPU)
		}
	}
	for i, name := range []string{"legacy", "shared"} {
		b.ReportMetric(float64(walls[i])/float64(b.N), name+"-ns/op")
		b.ReportMetric(float64(cpus[i])/float64(b.N), name+"-cpu-ns/op")
	}
}
