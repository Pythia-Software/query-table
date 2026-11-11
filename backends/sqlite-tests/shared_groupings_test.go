package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"modernc.org/sqlite"
)

func init() {
	if err := sqlite.RegisterDeterministicScalarFunction("qt_test_shared_zoned", 2, func(_ *sqlite.FunctionContext, values []driver.Value) (driver.Value, error) {
		if values[0] == nil {
			return nil, nil
		}
		instant, err := time.Parse(time.RFC3339Nano, fmt.Sprint(values[0]))
		if err != nil {
			return nil, err
		}
		loc, err := time.LoadLocation(fmt.Sprint(values[1]))
		if err != nil {
			return nil, err
		}
		return instant.In(loc).Format("2006-01-02T15:04:05"), nil
	}); err != nil {
		panic(err)
	}
}

func sharedGroupingRequest(keys []string) qt.QueryRequestV3 {
	var metrics []qt.AggSpec
	for _, by := range [][]string{nil, keys, append(append([]string{}, keys...), "effort")} {
		metrics = append(metrics,
			qt.AggSpec{Op: "count", GroupBy: by},
			qt.AggSpec{Expression: "COUNT_DISTINCT([conversation_id])", GroupBy: by},
			qt.AggSpec{Op: "count", GroupBy: by, Distribution: &qt.MetricDistribution{Kind: "quantiles", Input: "[gap]", Probabilities: []float64{0.5, 0.9}}},
		)
	}
	for i := range metrics {
		metrics[i].ID = fmt.Sprintf("m%d", i)
	}
	return metricsV3(nil, nil, 0, 0, metrics...)
}

func sharedNumberDataset() qt.QueryDatasetV3 {
	d := sharedClauseDataset()
	yes := true
	d.Schema.Fields["depth"] = qt.FieldSpec{Name: "depth", Kind: qt.FieldNumber, Expr: "r.depth", Groupable: &yes, ExpressionNumeric: true, ServerFilter: true, Sortable: true}
	return d
}

const sharedNumberDDL = `ALTER TABLE timings ADD COLUMN depth;
UPDATE timings SET depth=CASE CAST(substr(id,2) AS INTEGER)%8
 WHEN 0 THEN NULL WHEN 1 THEN 0 WHEN 2 THEN -0.0 WHEN 3 THEN 1
 WHEN 4 THEN 1.0 WHEN 5 THEN 1.5 WHEN 6 THEN -2 ELSE 9007199254740991 END;`

func assertSharedGroupingParity(t *testing.T, db *sql.DB, log *statementLog, d qt.QueryDatasetV3, q qt.QueryRequestV3) qt.QueryResultV3 {
	t.Helper()
	log.reset(nil)
	got, gotErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	// Disable both host assertion and automatic proofs for the independent SQL
	// reference, including on deterministic sources accepted by the new path.
	d.SQLiteSharedMetricsSource = false
	log.reset(declineDirect)
	want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if !reflect.DeepEqual(got, want) || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
		t.Fatalf("shared:\n%#v / %v\nSQL:\n%#v / %v", got.Metrics, gotErr, want.Metrics, wantErr)
	}
	return got
}

func TestSharedClauseNumberKeys(t *testing.T) {
	for index, mutation := range []string{
		"", "DELETE FROM timings", "UPDATE timings SET depth=NULL",
		"UPDATE timings SET depth='invalid' WHERE id='r00000001'",
		"UPDATE timings SET depth=X'ff' WHERE id='r00000001'",
		"UPDATE timings SET depth=9007199254740992 WHERE id='r00000001'",
		"UPDATE timings SET depth=-9007199254740993 WHERE id='r00000001'",
		"UPDATE timings SET depth=1e101 WHERE id='r00000001'",
		"UPDATE timings SET depth=1e-310 WHERE id='r00000001'",
		"UPDATE timings SET depth='invalid' WHERE id='r00000060'",
		"UPDATE timings SET depth=9007199254740993 WHERE id='r00000060'",
	} {
		t.Run(fmt.Sprintf("mutation%d", index), func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(64)+sharedNumberDDL)
			if mutation != "" {
				if _, err := db.Exec(mutation); err != nil {
					t.Fatal(err)
				}
			}
			for _, mode := range []string{"normal", "unstaged", "groups", "samples", "minimum", "measured", "top", "filter"} {
				t.Run(mode, func(t *testing.T) {
					d, q := sharedNumberDataset(), sharedGroupingRequest([]string{"depth", "model"})
					switch mode {
					case "unstaged":
						d.MaxPopulation, d.MaxStagingBytes = 1, 1
					case "groups":
						d.MaxGroups = 2
					case "samples":
						d.MaxSamplesPerGroup = 2
					case "minimum", "measured", "top":
						for i := 3; i < len(q.Metrics); i++ {
							q.Metrics[i].MinCount = qt.MetricMinCount{Min: 3}
							if mode == "measured" {
								q.Metrics[i].MinCount.Distinct = "conversation_id"
							}
							if mode == "top" {
								q.Metrics[i].GroupLimit = 2
								q.Metrics[i].Sort = []qt.MetricSort{{Key: "group0", Dir: "desc", Nulls: "first"}}
							}
						}
					case "filter":
						for i := 3; i < len(q.Metrics); i++ {
							q.Metrics[i].Where = []qt.WhereTerm{{Field: "depth", Op: "<=", Value: "1.5"}}
						}
					}
					if mutation == "" && mode == "normal" {
						log.reset(nil)
						got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
						if err != nil || got.Total != 64 || log.count("WITH qt_shared_source") != 1 || log.count(populationMarker) != 0 {
							t.Fatalf("numeric keys did not share the population: %#v / %v", got, err)
						}
					}
					assertSharedGroupingParity(t, db, log, d, q)
				})
			}
		})
	}
}

func sharedCalendarBindings(d *qt.QueryDatasetV3) {
	yes := true
	d.Schema.Fields["day"] = qt.FieldSpec{Name: "day", Kind: qt.FieldText, Expr: "qt_test_metric_probe(date(r.at,'-7 hours'))", Groupable: &yes, ServerFilter: true, Sortable: true}
	d.Schema.Fields["hour"] = qt.FieldSpec{Name: "hour", Kind: qt.FieldNumber, Expr: "CAST(strftime('%H',r.at,'-7 hours') AS INTEGER)", Groupable: &yes, ExpressionNumeric: true, ServerFilter: true, Sortable: true}
}

func assertSharedProjectionParity(t *testing.T, db *sql.DB, log *statementLog, d qt.QueryDatasetV3, q qt.QueryRequestV3) qt.QueryResultV3 {
	t.Helper()
	d.SQLiteSharedMetricsSource = false
	log.reset(declineDirect)
	want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	d.SQLiteSharedMetricsSource = true
	log.reset(nil)
	got, gotErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if !reflect.DeepEqual(got, want) || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
		t.Fatalf("shared:\n%#v / %v\nSQL:\n%#v / %v", got.Metrics, gotErr, want.Metrics, wantErr)
	}
	if gotErr != nil || log.count("WITH qt_shared_source") != 1 || log.count(populationMarker) != 0 {
		t.Fatalf("projection did not finish through the shared read: %v", gotErr)
	}
	return got
}

func TestSharedClauseDeclaredCaseSensitiveFields(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(6))
	d := sharedClauseDataset()
	field := d.Schema.Fields["effort"]
	field.Name = "Model"
	d.Schema.Fields["Model"] = field
	q := metricsV3(nil, nil, 0, 0,
		qt.AggSpec{ID: "efforts", Op: "count", GroupBy: []string{"Model"}},
		qt.AggSpec{ID: "models", Op: "count", GroupBy: []string{"model"}},
		qt.AggSpec{ID: "values", Expression: "COUNT_DISTINCT([Model])", GroupBy: []string{"model"}},
		qt.AggSpec{ID: "filtered-effort", Op: "count", GroupBy: []string{"model"}, Where: []qt.WhereTerm{{Field: "Model", Op: "=", Value: "effort1"}}},
		qt.AggSpec{ID: "filtered-model", Op: "count", GroupBy: []string{"Model"}, Where: []qt.WhereTerm{{Field: "model", Op: "=", Value: "a"}}},
		qt.AggSpec{ID: "pairs", Expression: "MEDIAN([gap])", GroupBy: []string{"Model", "model"}},
	)
	assertSharedProjectionParity(t, db, log, d, q)
}

func TestSharedClauseDeclaredBindingAffinity(t *testing.T) {
	for name, expression := range map[string]string{
		"stored-real":   "r.gap",
		"stored-text":   "r.text_gap",
		"stored-blob":   "r.blob_gap",
		"cast-text":     "CAST(r.gap AS TEXT)",
		"cast-integer":  "CAST(r.gap AS INTEGER)",
		"cast-real":     "CAST(r.gap AS REAL)",
		"cast-numeric":  "CAST(r.gap AS NUMERIC)",
		"unary-text":    "+(CAST(r.gap AS TEXT))",
		"function-text": "qt_test_metric_probe(CAST(r.gap AS TEXT))",
	} {
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(6))
			if _, err := db.Exec(`ALTER TABLE timings ADD COLUMN text_gap TEXT;
ALTER TABLE timings ADD COLUMN blob_gap BLOB;
UPDATE timings SET gap=42,text_gap='42.0',blob_gap='42.0'`); err != nil {
				t.Fatal(err)
			}
			d := sharedClauseDataset()
			field := d.Schema.Fields["gap"]
			field.Expr = expression
			d.Schema.Fields["gap"] = field
			for i, op := range []string{"=", "!=", ">", ">=", "<", "<="} {
				t.Run(fmt.Sprintf("comparison%d", i), func(t *testing.T) {
					q := metricsV3(nil, nil, 0, 0,
						qt.AggSpec{ID: "filtered", Op: "count", GroupBy: []string{"effort"}, Where: []qt.WhereTerm{{Field: "gap", Op: op, Value: "42"}}},
						qt.AggSpec{ID: "total", Op: "count"},
					)
					got := assertSharedProjectionParity(t, db, log, d, q)
					if name == "cast-text" && op == "=" {
						var count int64
						for _, bucket := range got.Metrics[0].Buckets {
							count += bucket.Count
						}
						if count != 6 {
							t.Fatalf("text-affinity numeric filter matched %d rows, want 6", count)
						}
					}
				})
			}
		})
	}
}

func TestSharedClauseDeclaredWindowBindings(t *testing.T) {
	for name, expression := range map[string]string{
		"row-number":  "row_number() OVER (ORDER BY r.id)",
		"partitioned": "row_number() OVER (PARTITION BY r.effort ORDER BY r.id)",
		"sum":         "SUM(r.gap) OVER ()",
		"lag":         "LAG(r.gap) OVER (ORDER BY r.id)",
	} {
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(6))
			d := sharedNumberDataset()
			field := d.Schema.Fields["depth"]
			field.Expr = expression
			d.Schema.Fields["depth"] = field
			q := metricsV3([]qt.WhereTerm{{Field: "id", Op: "=", Value: "r00000004"}}, nil, 0, 0,
				qt.AggSpec{ID: "window", Op: "count", GroupBy: []string{"depth"}},
				qt.AggSpec{ID: "total", Op: "count"},
			)
			got := assertSharedProjectionParity(t, db, log, d, q)
			if got.Total != 1 || len(got.Metrics[0].Buckets) != 1 {
				t.Fatalf("filtered window population: %#v", got)
			}
			if name == "row-number" && got.Metrics[0].Buckets[0].Keys[0] != float64(4) {
				t.Fatalf("window saw the filtered population: %#v", got.Metrics[0])
			}
		})
	}
}

func TestSharedClauseDeclaredWindowFilters(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(6))
	d := sharedNumberDataset()
	field := d.Schema.Fields["depth"]
	field.Expr = "row_number() OVER (ORDER BY r.id)"
	d.Schema.Fields["depth"] = field
	q := metricsV3([]qt.WhereTerm{{Field: "depth", Op: ">=", Value: "4"}}, nil, 0, 0,
		qt.AggSpec{ID: "window", Op: "count", GroupBy: []string{"depth"}, Where: []qt.WhereTerm{{Field: "depth", Op: "<=", Value: "5"}}},
		qt.AggSpec{ID: "total", Op: "count"},
	)
	got := assertSharedProjectionParity(t, db, log, d, q)
	if got.Total != 3 || len(got.Metrics[0].Buckets) != 2 || got.Metrics[0].Buckets[0].Keys[0] != float64(4) || got.Metrics[0].Buckets[1].Keys[0] != float64(5) {
		t.Fatalf("window filter population: %#v", got)
	}
}

func TestSharedClauseDeclaredSource(t *testing.T) {
	for _, source := range []string{"bindings", "projection", "union", "cte-name", "binding-cte-name"} {
		t.Run(source, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			d := sharedClauseDataset()
			sharedCalendarBindings(&d)
			switch source {
			case "projection":
				d.SourceSQL = "SELECT *,qt_test_metric_probe(date(at,'-7 hours')) AS day,CAST(strftime('%H',at,'-7 hours') AS INTEGER) AS hour FROM timings WHERE tenant=?"
				for _, name := range []string{"day", "hour"} {
					field := d.Schema.Fields[name]
					field.Expr = "r." + name
					d.Schema.Fields[name] = field
				}
			case "union":
				d.SourceSQL = "SELECT * FROM timings WHERE tenant=? AND id<=? UNION ALL SELECT * FROM timings WHERE tenant=? AND id>?"
				d.SourceArgs = []any{"allowed", "r00000030", "allowed", "r00000030"}
			case "cte-name":
				d.SourceSQL = "WITH QT_SHARED_VALUES AS (SELECT * FROM timings WHERE tenant=?), QT_SHARED_BINDINGS AS (SELECT * FROM QT_SHARED_VALUES) SELECT * FROM QT_SHARED_BINDINGS"
			case "binding-cte-name":
				if _, err := db.Exec(`CREATE TABLE qt_shared_source AS SELECT id,date(at,'-7 hours') AS day FROM timings;
CREATE TABLE qt_shared_values AS SELECT id,CAST(strftime('%H',at,'-7 hours') AS INTEGER) AS hour FROM timings`); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"day", "hour"} {
					field := d.Schema.Fields[name]
					field.Expr = "qt_test_metric_probe((SELECT day FROM qt_shared_source WHERE id=r.id))"
					if name == "hour" {
						field.Expr = "(SELECT hour FROM qt_shared_values WHERE id=r.id)"
					}
					d.Schema.Fields[name] = field
				}
			}
			q := sharedGroupingRequest([]string{"model", "day", "hour"})
			q.Result.Where = []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-01T00:00:00Z"}}
			// Both predicates use projected expressions, and their numbered
			// parameters precede the request predicate's parameters in the API.
			q.Metrics[3].Where = []qt.WhereTerm{{Field: "day", Op: "!=", Value: "2026-01-01"}}
			q.Metrics[4].Where = []qt.WhereTerm{{Field: "hour", Op: ">=", Value: "0"}}
			log.reset(nil)
			if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil || log.count("WITH qt_shared_source") != 0 {
				t.Fatalf("opaque source bypassed its proof: %v", err)
			}
			d.SQLiteSharedMetricsSource = true
			log.reset(nil)
			metricProbeCalls.Store(0)
			got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil || got.Total != 60 || metricProbeCalls.Load() != 60 || log.count(populationMarker) != 0 {
				t.Fatalf("shared bindings: total=%d, evaluations=%d, err=%v", got.Total, metricProbeCalls.Load(), err)
			}
			reads := 0
			for _, statement := range log.seen {
				if strings.Contains(statement, "FROM timings") && !strings.HasPrefix(statement, "EXPLAIN ") {
					reads++
				}
			}
			if reads != 1 || log.count("AS MATERIALIZED (SELECT") != 1 {
				t.Fatalf("source statements=%d, projected reads=%d", reads, log.count("AS MATERIALIZED (SELECT"))
			}
			for _, mode := range []string{"normal", "unstaged", "groups", "samples", "minimum", "top", "calendar-population", "calendar-bytes"} {
				t.Run(mode, func(t *testing.T) {
					limited, request := d, q
					request.Metrics = append([]qt.AggSpec{}, q.Metrics...)
					switch mode {
					case "unstaged":
						limited.MaxPopulation, limited.MaxStagingBytes = 1, 1
					case "groups":
						limited.MaxGroups = 2
					case "samples":
						limited.MaxSamplesPerGroup = 2
					case "minimum", "top":
						for i := 3; i < len(request.Metrics); i++ {
							request.Metrics[i].MinCount = qt.MetricMinCount{Min: 3, Distinct: "conversation_id"}
							if mode == "top" {
								request.Metrics[i].GroupLimit = 2
							}
						}
					case "calendar-population", "calendar-bytes":
						request.Metrics = append(request.Metrics, sharedClauseRequest().Metrics[11])
						if mode == "calendar-population" {
							limited.MaxPopulation = 2
						} else {
							limited.MaxStagingBytes = 64
						}
					}
					assertSharedGroupingParity(t, db, log, limited, request)
				})
			}
		})
	}
}

func TestSharedClauseDeclaredBindingFailure(t *testing.T) {
	for _, filters := range []bool{false, true} {
		t.Run(fmt.Sprint(filters), func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			if _, err := db.Exec("UPDATE timings SET model=CAST(X'ff' AS TEXT) WHERE id='r00000030'"); err != nil {
				t.Fatal(err)
			}
			d := sharedClauseDataset()
			d.SQLiteSharedMetricsSource = true
			field := d.Schema.Fields["effort"]
			// This deterministic expression throws for invalid UTF-8, including
			// when it is a group binding rather than a clause-filter flag.
			field.Expr = "qt_lower(r.model)"
			d.Schema.Fields["effort"] = field
			q := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "bad", Op: "count", GroupBy: []string{"effort"}}, qt.AggSpec{ID: "healthy", Op: "count"})
			if filters {
				q.Metrics[0].Where = []qt.WhereTerm{{Field: "effort", Op: "contains", Value: "a"}}
			}
			got := assertSharedGroupingParity(t, db, log, d, q)
			if got.Total != 60 || got.Metrics[0].Error == "" || got.Metrics[1].Error != "" {
				t.Fatalf("binding error lost sibling results: %#v", got)
			}
		})
	}
}

func TestSharedClauseDeclaredZonedKeys(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(60))
	// Both occurrences of 01:30 belong to the same day/hour cell in Denver;
	// the next day's 01:30 and the NULL datetime remain separate cells.
	if _, err := db.Exec(`UPDATE timings SET at=CASE CAST(substr(id,2) AS INTEGER)%4
 WHEN 0 THEN NULL WHEN 1 THEN '2026-11-01T07:30:00Z'
 WHEN 2 THEN '2026-11-01T08:30:00Z' ELSE '2026-11-02T08:30:00Z' END`); err != nil {
		t.Fatal(err)
	}
	d := sharedClauseDataset()
	sharedCalendarBindings(&d)
	for _, name := range []string{"day", "hour"} {
		field := d.Schema.Fields[name]
		field.Expr = "date(qt_test_shared_zoned(r.at,'America/Denver'))"
		if name == "hour" {
			field.Expr = "CAST(strftime('%H',qt_test_shared_zoned(r.at,'America/Denver')) AS INTEGER)"
		}
		d.Schema.Fields[name] = field
	}
	d.SQLiteSharedMetricsSource = true
	q := sharedGroupingRequest([]string{"day", "hour"})
	got := assertSharedGroupingParity(t, db, log, d, q)
	if got.Metrics[3].GroupCount != 3 {
		t.Fatal(got.Metrics[3])
	}
	first := got.Metrics[3].Buckets[0]
	if !reflect.DeepEqual([]any(first.Keys), []any{"2026-11-01", float64(1)}) || first.Count != 30 {
		t.Fatalf("repeated hour cell: %#v", first)
	}
}

func TestSharedClauseDeclaredSourceGuards(t *testing.T) {
	for _, guard := range []string{"revision", "token", "snapshot", "cancellation"} {
		t.Run(guard, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			d := sharedClauseDataset()
			sharedCalendarBindings(&d)
			d.SQLiteSharedMetricsSource = true
			q := sharedGroupingRequest([]string{"day", "hour"})
			o := qt.PlanOptions{}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch guard {
			case "revision":
				q.ExpectedRevisions = map[string]string{"unused": "stale"}
				o.Resolver = qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
					return qt.ComputedColumn{ID: id, Label: "Unused", Revision: "current", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[gap]*2"}}, nil
				})
			case "token":
				q.PlanToken = "rejected"
				o.ValidatePlanToken = func(context.Context, string) error { return errors.New("test: expired token") }
			case "snapshot":
				q.Snapshot = "rejected"
				o.ValidateSnapshot = func(context.Context, string) error { return errors.New("test: expired snapshot") }
			case "cancellation":
				cancel()
			}
			tx, err := db.BeginTx(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			metricProbeCalls.Store(0)
			log.reset(nil)
			if _, err = d.ExecuteIn(ctx, tx, q, o); err == nil {
				t.Fatal("execution guard was bypassed")
			}
			if metricProbeCalls.Load() != 0 || log.count("WITH qt_shared_source") != 0 {
				t.Fatal("source was evaluated before execution guards")
			}
		})
	}
}

func TestSharedClauseDeclaredCancellation(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(60))
	d := sharedClauseDataset()
	sharedCalendarBindings(&d)
	d.SQLiteSharedMetricsSource = true
	q := sharedGroupingRequest([]string{"day", "hour"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	metricProbeCalls.Store(0)
	metricProbeCancel, metricProbeCancelAfter = cancel, 8
	defer func() { metricProbeCancel = nil }()
	log.reset(nil)
	_, err := d.Execute(ctx, db, q, qt.PlanOptions{})
	if !errors.Is(err, context.Canceled) || metricProbeCalls.Load() <= 8 || log.count(populationMarker) != 0 {
		t.Fatalf("cancellation was retried: %v, evaluations=%d", err, metricProbeCalls.Load())
	}
}
