package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// The input is synthetic: 1.2 million rows, 287,999 in the requested month.
// Compare the unchanged SQL executor with numeric keys, two host calendar
// bindings, and a UNION ALL combining stored and freshly derived values.
func BenchmarkSharedGroupingScans(b *testing.B) {
	dsn := "file:" + filepath.ToSlash(filepath.Join(b.TempDir(), "groupings.db")) + "?_pragma=cache_size(-32768)"
	base, err := sql.Open("sqlite", dsn)
	if err != nil {
		b.Fatal(err)
	}
	declineNextProof, sourceReads := false, 0
	db := sql.OpenDB(statementHookConnector{base: base.Driver(), dsn: dsn, hook: func(statement string) error {
		if strings.HasPrefix(statement, "EXPLAIN ") {
			if declineNextProof {
				declineNextProof = false
				return errors.New("benchmark: use independent SQL clauses")
			}
		} else if strings.Contains(statement, "FROM timings") {
			sourceReads++
		}
		return nil
	}})
	base.Close()
	db.SetMaxOpenConns(1)
	b.Cleanup(func() { db.Close() })
	ddl := strings.ReplaceAll(strings.ReplaceAll(sharedClauseDDL(1200000), "i*67", "i*9"), "1791000000", "1790812800")
	ddl += "ALTER TABLE timings ADD COLUMN depth INTEGER; UPDATE timings SET depth=CAST(substr(id,2) AS INTEGER)%6;"
	if _, err := db.Exec(ddl); err != nil {
		b.Fatal(err)
	}
	for _, shape := range []string{"number", "cells", "derived"} {
		b.Run(shape, func(b *testing.B) {
			for _, mode := range []string{"shared", "sql"} {
				b.Run(mode, func(b *testing.B) {
					d, q := sharedNumberDataset(), sharedGroupingRequest([]string{"depth"})
					d.MaxGroups = 10000
					q.Result.Where = sharedClauseRequest().Result.Where
					q.Result.Where[1].Value = "2026-10-31T00:00:00Z"
					if shape == "cells" {
						sharedCalendarBindings(&d)
						// Avoid the test probe's atomic counter in timing measurements.
						day := d.Schema.Fields["day"]
						day.Expr = "date(r.at,'-7 hours')"
						d.Schema.Fields["day"] = day
						q.Metrics = sharedGroupingRequest([]string{"model", "day", "hour"}).Metrics[4:6]
					}
					if shape == "derived" {
						d.SourceSQL = `SELECT * FROM timings WHERE tenant=?1 AND CAST(substr(id,2) AS INTEGER)%10<>0
UNION ALL SELECT id,conversation_id,model,effort,at,gap+0.0,tenant,depth FROM timings WHERE tenant=?1 AND CAST(substr(id,2) AS INTEGER)%10=0`
					}
					d.SQLiteSharedMetricsSource = mode == "shared" && shape != "number"
					runBenchmark(b, func() {
						declineNextProof, sourceReads = mode == "sql", 0
						out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
						if err != nil {
							b.Fatal(err)
						}
						if out.Total != 287999 {
							b.Fatalf("population: %d", out.Total)
						}
						if mode == "shared" && sourceReads != 1 {
							b.Fatalf("shared source statements: %d", sourceReads)
						}
						for _, metric := range out.Metrics {
							if metric.Error != "" {
								b.Fatal(metric.ID, metric.Error)
							}
							for _, bucket := range metric.Buckets {
								if bucket.Error != "" {
									b.Fatal(metric.ID, bucket.Error)
								}
							}
						}
						b.ReportMetric(float64(sourceReads), "source-statements/op")
					})
				})
			}
		})
	}
}
