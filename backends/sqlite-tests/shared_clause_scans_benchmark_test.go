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

// Synthetic Thinking workload: 1.2 million stored rows, 288,000 in a
// 30-day indexed range, and 19 clauses including eight calendar reductions.
// The native comparison transfers enough ordered values for exact quantiles.
func BenchmarkSharedClauseScans(b *testing.B) {
	dsn := "file:" + filepath.ToSlash(filepath.Join(b.TempDir(), "shared.db")) + "?_pragma=cache_size(-32768)"
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
	if _, err = db.Exec(strings.ReplaceAll(strings.ReplaceAll(sharedClauseDDL(1200000), "i*67", "i*9"), "1791000000", "1790812800")); err != nil {
		b.Fatal(err)
	}
	d, q := sharedClauseDataset(), sharedClauseRequest()
	q.Result.Where[1].Value = "2026-10-31T00:00:00Z"
	for _, mode := range []string{"shared", "sql", "native"} {
		b.Run(mode, func(b *testing.B) {
			runBenchmark(b, func() {
				if mode == "native" {
					rows, err := db.Query(`SELECT model,effort,conversation_id,gap FROM timings WHERE tenant=?1 AND at>=?2 AND at<?3 ORDER BY model COLLATE BINARY,gap`, "allowed", q.Result.Where[0].Value, q.Result.Where[1].Value)
					if err != nil {
						b.Fatal(err)
					}
					defer rows.Close()
					for rows.Next() {
						var model, effort, conversation, gap any
						if err := rows.Scan(&model, &effort, &conversation, &gap); err != nil {
							b.Fatal(err)
						}
					}
					if err := rows.Err(); err != nil {
						b.Fatal(err)
					}
					return
				}
				declineNextProof, sourceReads = mode == "sql", 0
				{
					out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
					if err != nil {
						b.Fatal(err)
					}
					if out.Total != 287999 {
						b.Fatalf("population: %d", out.Total)
					}
					if mode == "shared" && sourceReads != 1 {
						b.Fatalf("shared source reads: %d", sourceReads)
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
				}
			})
		})
	}
}
