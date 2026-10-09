package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestProfileLatency(t *testing.T) {
	if os.Getenv("QT_DEMO_PROFILE") == "" {
		t.Skip("profiling only")
	}
	dsn := os.Getenv("QT_DEMO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("QT_DEMO_TEST_DATABASE_URL is required")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = "qt_demo,public"
	db := stdlib.OpenDB(*config)
	defer db.Close()
	s, err := qt.LoadSchema(schemaJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll("../../.context/postgres-demo", 0755); err != nil {
		t.Fatal(err)
	}
	for _, jit := range []string{"on", "off"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, "SET LOCAL jit="+jit+"; SET LOCAL work_mem='32MB'; SET LOCAL statement_timeout='60s'"); err != nil {
			t.Fatal(err)
		}
		resolver := qt.SQLComputedDefinitionResolver{Tx: tx, Scope: scope, Dataset: dataset}
		revisions := map[string]string{}
		for _, id := range []string{"throughput", "seconds", "slow", "duration_band"} {
			c, e := resolver.ResolveComputed(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			revisions[id] = c.Revision
		}
		opts := qt.PlanOptions{SourceSQL: sourceSQL, Resolver: resolver, ExpectedRevisions: revisions, ComputedGroupable: map[string]bool{"duration_band": true}}
		q := qt.WireQuery{Select: []string{"id", "job_name", "platform", "overall", "total_ms", "@computed/throughput", "worker", "enqueued_at"}, OrderBy: []qt.OrderBy{{Field: "enqueued_at", Dir: "desc", Nulls: "last"}}, Limit: 100}
		rp, e := qt.CompileComputedRows(ctx, q, s, opts)
		if e != nil {
			t.Fatal(e)
		}
		rp, e = qt.CompileComputedRows(ctx, q, narrowSchema(s, rp.Dependencies, q.Where), opts)
		if e != nil {
			t.Fatal(e)
		}
		plans := map[string]qt.SQLPlan{"rows": rp}
		for _, spec := range []qt.AggSpec{{ID: "throughput", Expression: "AVG([@computed/throughput])", GroupBy: []string{"worker"}}, {ID: "histogram", GroupBy: []string{"platform"}, Distribution: &qt.MetricDistribution{Kind: "histogram", Input: "[total_ms]", Bins: 20}}, {ID: "ratio", Expression: `SUM(IF([overall] = "PASS", 1, 0)) / NULLIF(COUNT(), 0)`, GroupBy: []string{"platform"}}} {
			mq := qt.MetricQuery{Version: 2, Limit: 100, Metrics: []qt.AggSpec{spec}}
			p, e := qt.CompileMetrics(ctx, mq, s, opts)
			if e != nil {
				t.Fatal(e)
			}
			p, e = qt.CompileMetrics(ctx, mq, narrowSchema(s, p.Metrics[0].Dependencies, nil), opts)
			if e != nil {
				t.Fatal(e)
			}
			plans[spec.ID] = p.Metrics[0].SQLPlan
		}
		for _, name := range []string{"rows", "throughput", "histogram", "ratio"} {
			p := plans[name]
			var explain []byte
			start := time.Now()
			err := tx.QueryRowContext(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+p.SQL, p.Args...).Scan(&explain)
			if err != nil {
				t.Fatal(name, err)
			}
			var data any
			if err := json.Unmarshal(explain, &data); err != nil {
				t.Fatal(err)
			}
			pretty, err := json.MarshalIndent(data, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile("../../.context/postgres-demo/explain-"+name+"-"+jit+".json", pretty, 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile("../../.context/postgres-demo/sql-"+name+".txt", []byte(p.SQL), 0644); err != nil {
				t.Fatal(err)
			}
			fmt.Printf("PROFILE %s jit=%s elapsed=%s stages=%d bytes=%d\n", name, jit, time.Since(start), len(p.Stages), len(p.SQL))
		}
		tx.Rollback()
	}
}
