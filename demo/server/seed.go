package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	qt "github.com/Pythia-Software/query-table/backends/go"
)

//go:embed schema.json
var schemaJSON []byte

const dataset = "postgres-runs"
const scope = "local-demo"
const seedVersion = "runs-v1"
const sourceSQL = `SELECT * FROM qt_demo.runs`

var seededColumns = []qt.ComputedColumn{
	{ID: "seconds", Label: "Duration (seconds)", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[total_ms] / 1000"}},
	{ID: "throughput", Label: "Throughput (MB/s)", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[input_mb] / NULLIF([total_ms] / 1000, 0)"}},
	{ID: "slow", Label: "Slow run", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[total_ms] >= 60000"}},
	{ID: "duration_band", Label: "Duration band", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: `IF(IS_NULL([total_ms]), "Missing", IF([total_ms] >= 60000, "Slow", IF([total_ms] >= 15000, "Medium", "Fast")))`}},
}

// All writes are confined to our dedicated qt_demo schema. Generation is
// deterministic and server-side: the browser never downloads this population.
func seed(ctx context.Context, db *sql.DB, n int) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(7179317)`); err != nil {
		return err
	}
	ddl := `CREATE SCHEMA IF NOT EXISTS qt_demo;
 CREATE TABLE IF NOT EXISTS qt_demo.meta (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version text NOT NULL, rows bigint NOT NULL);
 CREATE TABLE IF NOT EXISTS qt_demo.runs (
 id bigint PRIMARY KEY, job_name text, platform text NOT NULL, overall text, total_ms double precision,
 queue_ms double precision, input_mb double precision NOT NULL, worker text NOT NULL,
 run_day text NOT NULL, hour integer NOT NULL, enqueued_at timestamptz NOT NULL, is_starred boolean NOT NULL);
 CREATE INDEX IF NOT EXISTS runs_time_idx ON qt_demo.runs(enqueued_at DESC,id);
 CREATE INDEX IF NOT EXISTS runs_platform_idx ON qt_demo.runs(platform);
 CREATE INDEX IF NOT EXISTS runs_day_idx ON qt_demo.runs(run_day);
 CREATE INDEX IF NOT EXISTS runs_numeric_id_idx ON qt_demo.runs((id::double precision));
 CREATE INDEX IF NOT EXISTS runs_worker_idx ON qt_demo.runs(worker);
 CREATE INDEX IF NOT EXISTS runs_result_idx ON qt_demo.runs(overall);
 CREATE INDEX IF NOT EXISTS runs_duration_idx ON qt_demo.runs(total_ms);
 CREATE INDEX IF NOT EXISTS runs_worker_c_idx ON qt_demo.runs(worker COLLATE "C");
 CREATE INDEX IF NOT EXISTS runs_result_c_idx ON qt_demo.runs(overall COLLATE "C");
 CREATE INDEX IF NOT EXISTS runs_platform_c_idx ON qt_demo.runs(platform COLLATE "C");`
	if _, err = tx.ExecContext(ctx, ddl); err != nil {
		return err
	}
	var version string
	var count int
	err = tx.QueryRowContext(ctx, `SELECT version,rows FROM qt_demo.meta WHERE singleton`).Scan(&version, &count)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if version != seedVersion || count != n {
		if _, err = tx.ExecContext(ctx, `TRUNCATE qt_demo.runs`); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO qt_demo.runs
  WITH raw AS (SELECT i, (i*7919%997)::double precision/997 AS a, (i*3571%991)::double precision/991 AS b,
    (i*1013%983)::double precision/983 AS c, (i*179%977)::double precision/977 AS d,
    timestamptz '2026-09-01 00:00:00+00' + ((i*173%3888000)::double precision * interval '1 second') AS happened
    FROM generate_series(1,$1::bigint) i)
  SELECT i, CASE WHEN i%113=0 THEN NULL ELSE (ARRAY['checkout-flow','login-oauth','invoice-export','report-builder','pivot-refresh','bulk-upload','search-index','render-snapshot','api-contract','payment-retry','data-sync','permissions'])[1+(i*31%12)::integer] END,
    CASE WHEN a<0.55 THEN 'linux' WHEN a<0.8 THEN 'macos' ELSE 'windows' END,
    CASE WHEN c<0.02 THEN NULL WHEN c<0.12 THEN 'FAIL' WHEN c<0.17 THEN 'DIFFERENCES' ELSE 'PASS' END,
    CASE WHEN i%37=0 THEN NULL ELSE round((1200+power(b,3)*150000+CASE WHEN a>0.8 THEN 7000 ELSE 0 END)*CASE WHEN i%211=0 THEN 8 ELSE 1 END) END,
    round(50+power(d,4)*25000), round((5+a*495)*100)/100,
    'worker-'||lpad((1+(i*17%24))::text,2,'0'),to_char(happened AT TIME ZONE 'UTC','YYYY-MM-DD'),extract(hour FROM happened AT TIME ZONE 'UTC')::integer,happened,i%7=0
  FROM raw`, n)
		if err != nil {
			return fmt.Errorf("seed runs: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO qt_demo.meta VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,rows=excluded.rows`, seedVersion, n); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `ANALYZE qt_demo.runs`); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, qt.ComputedColumnsDDL); err != nil {
		return err
	}
	for _, c := range seededColumns {
		_, err = tx.ExecContext(ctx, `INSERT INTO query_table_computed_columns(scope,dataset,id,label,language,language_version,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, scope, dataset, c.ID, c.Label, c.Expression.Language, c.Expression.Version, c.Expression.Source)
		if err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `ANALYZE qt_demo.runs`); err != nil {
		return err
	}
	return tx.Commit()
}

func jsonValue(value any) any {
	switch v := value.(type) {
	case []byte:
		var decoded any
		if json.Unmarshal(v, &decoded) == nil {
			return decoded
		}
		return string(v)
	default:
		return value
	}
}
