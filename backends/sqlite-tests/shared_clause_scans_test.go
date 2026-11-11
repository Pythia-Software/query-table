package sqlitetests

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestSharedClauseSourceParameters(t *testing.T) {
	for name, source := range map[string]string{
		"anonymous": "SELECT * FROM timings WHERE tenant=? AND id<>?",
		"numbered":  "SELECT * FROM timings WHERE tenant=?1 AND id<>?2",
		"mixed":     "SELECT * FROM timings WHERE tenant=?1 AND id<>?",
		"cte-name":  "WITH QT_SHARED_SOURCE AS (SELECT * FROM timings WHERE tenant=? AND id<>?) SELECT * FROM QT_SHARED_SOURCE",
	} {
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			d, q := sharedClauseDataset(), sharedClauseRequest()
			d.SourceSQL, d.SourceArgs = source, []any{"allowed", "r00000002"}
			// Bound metric predicates appear in SELECT, before the outer request
			// predicate. Neither may renumber anonymous source parameters.
			q.Metrics[0].Where = []qt.WhereTerm{{Field: "gap", Op: ">", Value: "300"}}
			q.Metrics[2].Where = []qt.WhereTerm{{Field: "gap", Op: "<", Value: "800"}}
			log.reset(nil)
			got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if got.Total != 59 || log.count(populationMarker) != 0 {
				t.Fatalf("shared population: %d, count probes: %d", got.Total, log.count(populationMarker))
			}
			log.reset(declineDirect)
			want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("source %s: got %#v, want %#v / %v", source, got.Metrics, want.Metrics, err)
			}
		})
	}
}

func TestSharedClauseFilterFailureIsolation(t *testing.T) {
	for _, id := range []string{"r00000001", "r00000030"} {
		t.Run(id, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			if _, err := db.Exec("UPDATE timings SET model=CAST(X'ff' AS TEXT) WHERE id=?", id); err != nil {
				t.Fatal(err)
			}
			d := sharedClauseDataset()
			q := metricsV3(nil, nil, 0, 0,
				qt.AggSpec{ID: "filtered", Op: "count", GroupBy: []string{"effort"}, Where: []qt.WhereTerm{{Field: "model", Op: "contains", Value: "a"}}},
				qt.AggSpec{ID: "healthy", Op: "count"},
			)
			log.reset(nil)
			got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil {
				t.Fatalf("clause filter aborted its siblings: %v", err)
			}
			if log.count("WITH qt_shared_source") != 1 {
				t.Fatal("shared filter failure was not exercised")
			}
			if got.Total != 60 || got.SourceTotal != 60 || got.Metrics[0].ErrorCode != "internal" || got.Metrics[1].Error != "" || got.Metrics[1].Buckets[0].Value != float64(60) {
				t.Fatalf("filter failure result: %#v", got)
			}
			log.reset(declineDirect)
			want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("shared: %#v, SQL: %#v / %v", got.Metrics, want.Metrics, err)
			}
			// The same failure in the request predicate must still abort it.
			q.Result.Where = q.Metrics[0].Where
			log.reset(nil)
			if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
				t.Fatal("request filter failure was swallowed")
			}
		})
	}
}

func TestSharedClauseSourceFailure(t *testing.T) {
	for _, test := range []struct {
		name    string
		failure error
		filters bool
	}{
		{"source", errors.New("injected source read failure"), false},
		{"cancellation", context.Canceled, true},
		{"deadline", context.DeadlineExceeded, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			log.reset(func(statement string) error {
				if strings.HasPrefix(statement, "WITH qt_shared_source") {
					return test.failure
				}
				return nil
			})
			q := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "efforts", Op: "count", GroupBy: []string{"effort"}}, qt.AggSpec{ID: "total", Op: "count"})
			if test.filters {
				q.Metrics[0].Where = []qt.WhereTerm{{Field: "gap", Op: ">", Value: "300"}}
			}
			// An unambiguous source failure, or cancellation even with filter
			// flags, must fail the request instead of triggering a retry.
			_, err := sharedClauseDataset().Execute(context.Background(), db, q, qt.PlanOptions{})
			if !errors.Is(err, test.failure) || log.count(populationMarker) != 0 {
				t.Fatalf("source failure was masked: %v", err)
			}
		})
	}
}

func TestSharedClauseScalarGroupingSets(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(60))
	d := sharedClauseDataset()
	d.MaxPopulation = 1 // Ordinary ungrouped metrics do not stage a population.
	q := metricsV3(nil, nil, 0, 0,
		qt.AggSpec{ID: "models", Op: "count", GroupBy: []string{"model"}, GroupLimit: 1, MinCount: qt.MetricMinCount{Min: 2, Distinct: "conversation_id"}},
		qt.AggSpec{ID: "efforts", Op: "count", GroupBy: []string{"effort"}, Where: []qt.WhereTerm{{Field: "gap", Op: "is_not_null"}}},
	)
	for _, tenant := range []string{"allowed", "denied", "empty"} {
		d.SourceArgs = []any{tenant}
		log.reset(nil)
		got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if log.count("SELECT +(") != 1 || log.count(populationMarker) != 0 {
			t.Fatal("grouping sets did not share their total")
		}
		log.reset(declineDirect)
		want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %#v, want %#v / %v", tenant, got.Metrics, want.Metrics, err)
		}
	}
}

func sharedClauseDDL(rows int) string {
	return fmt.Sprintf(`CREATE TABLE timings(id TEXT,conversation_id TEXT,model TEXT COLLATE NOCASE,effort TEXT,at TEXT,gap REAL,tenant TEXT);
WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
INSERT INTO timings SELECT printf('r%%08d',i),'c'||(i/3),CASE WHEN i%%5=0 THEN NULL WHEN i%%3=0 THEN 'A' WHEN i%%3=1 THEN 'a' ELSE 'other' END,
'effort'||(i%%3),strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ',1791000000+i*67,'unixepoch'),CASE WHEN i%%10=0 THEN NULL ELSE (i*7919%%10000)/10.0 END,'allowed' FROM nums;
INSERT INTO timings VALUES('excluded','excluded','excluded','excluded','2026-11-01T12:00:00Z',9999,'denied');
CREATE INDEX timings_at ON timings(at);`, rows)
}

func sharedClauseDataset() qt.QueryDatasetV3 {
	s := qt.Schema{Name: "timings", IDField: "id", Fields: map[string]qt.FieldSpec{}}
	for _, name := range []string{"id", "conversation_id", "model", "effort", "at", "gap"} {
		kind := qt.FieldText
		if name == "at" {
			kind = qt.FieldDatetime
		}
		if name == "gap" {
			kind = qt.FieldNumber
		}
		yes := true
		s.Fields[name] = qt.FieldSpec{Name: name, Kind: kind, Expr: "r." + name, Sortable: true, ServerFilter: true, ExpressionNumeric: true, Groupable: &yes}
		if kind == qt.FieldDatetime {
			f := s.Fields[name]
			f.SQLiteDatetimeFormat = "rfc3339"
			s.Fields[name] = f
		}
	}
	return qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM timings WHERE tenant=?1", SourceArgs: []any{"allowed"}, MaxPopulation: 1000000}
}

// Nineteen clauses over one population, with different grouping sets,
// clause filters, and eight calendar clauses sharing one configuration.
func sharedClauseRequest() qt.QueryRequestV3 {
	var metrics []qt.AggSpec
	for _, by := range [][]string{nil, {"model"}, {"model", "effort"}} {
		metrics = append(metrics,
			qt.AggSpec{Op: "count", GroupBy: by},
			qt.AggSpec{Expression: "COUNT_DISTINCT([conversation_id])", GroupBy: by},
			qt.AggSpec{Op: "count", GroupBy: by, Where: []qt.WhereTerm{{Field: "gap", Op: "is_not_null"}}, Distribution: &qt.MetricDistribution{Kind: "quantiles", Input: "[gap]", Probabilities: []float64{0.5, 0.75, 0.9, 0.95}}})
	}
	metrics = append(metrics, qt.AggSpec{Op: "count", GroupBy: []string{"effort"}}, qt.AggSpec{Op: "sum", Field: "gap", GroupBy: []string{"model"}})
	date := &qt.MetricDateGrouping{Field: "at", Interval: "day", Every: 1, TimeZone: "America/Denver", Range: "observed"}
	for _, expression := range []string{"COUNT()", "COUNT_DISTINCT([conversation_id])", "PERCENTILE([gap],0.5)", "PERCENTILE([gap],0.75)", "PERCENTILE([gap],0.9)", "PERCENTILE([gap],0.95)", "SUM([gap])", "AVG([gap])"} {
		metrics = append(metrics, qt.AggSpec{Expression: expression, GroupBy: []string{"at", "model"}, DateGrouping: date})
	}
	for i := range metrics {
		metrics[i].ID = fmt.Sprintf("m%d", i)
	}
	return metricsV3([]qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-10-01T00:00:00Z"}, {Field: "at", Op: "<", Value: "2026-12-01T00:00:00Z"}}, nil, 0, 0, metrics...)
}

func TestSharedClauseScan(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, sharedClauseDDL(1200))
	d, q := sharedClauseDataset(), sharedClauseRequest()
	log.reset(nil)
	got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Metrics) != 19 || got.Total != 1200 {
		t.Fatal(got)
	}
	reads := 0
	for _, statement := range log.seen {
		if strings.Contains(statement, "FROM timings") && !strings.HasPrefix(statement, "EXPLAIN ") {
			reads++
		}
	}
	if reads != 1 || log.count("CREATE TEMP TABLE") != 0 {
		t.Fatalf("source reads=%d, scratch=%d", reads, log.count("CREATE TEMP TABLE"))
	}
	log.reset(declineDirect)
	want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("shared:\n%#v\nSQL:\n%#v\n%v", got.Metrics, want.Metrics, err)
	}
	// Public results must not alias shared groups, samples, or payloads.
	got.Metrics[0].Buckets[0].Keys = append(got.Metrics[0].Buckets[0].Keys, "mutated")
	if reflect.DeepEqual(got.Metrics[0].Buckets[0].Keys, got.Metrics[1].Buckets[0].Keys) {
		t.Fatal("aliased keys")
	}
}

func TestSharedClauseParity(t *testing.T) {
	for index, mutation := range []string{"", "DELETE FROM timings", "UPDATE timings SET gap=NULL", "UPDATE timings SET gap='invalid' WHERE id='r00000001'", "UPDATE timings SET gap=9007199254740992 WHERE id='r00000001'", "UPDATE timings SET model=X'ff' WHERE id='r00000001'", "UPDATE timings SET at='invalid' WHERE id='r00000001'", "UPDATE timings SET at=CASE WHEN CAST(substr(id,2) AS INTEGER)%3=0 THEN NULL WHEN CAST(substr(id,2) AS INTEGER)%2=0 THEN '2026-11-01T07:30:00Z' ELSE '2026-11-01T08:30:00Z' END"} {
		t.Run(fmt.Sprintf("mutation%d", index), func(t *testing.T) {
			log := &statementLog{}
			db := hookedDB(t, log, sharedClauseDDL(60))
			d, q := sharedClauseDataset(), sharedClauseRequest()
			q.Result.Where = nil
			if mutation != "" {
				if _, err := db.Exec(mutation); err != nil {
					t.Fatal(err)
				}
			}
			for _, budgets := range []string{"normal", "groups", "samples", "population", "bytes", "minimum", "measured", "measured-sum", "top-min", "cycle", "every"} {
				t.Run(budgets, func(t *testing.T) {
					limited := d
					request := q
					request.Metrics = append([]qt.AggSpec{}, q.Metrics...)
					switch budgets {
					case "groups":
						limited.MaxGroups = 2
					case "samples":
						limited.MaxSamplesPerGroup = 3
					case "population":
						limited.MaxPopulation = 3
					case "bytes":
						limited.MaxStagingBytes = 64
					case "minimum":
						for i := range request.Metrics {
							if len(request.Metrics[i].GroupBy) > 0 {
								request.Metrics[i].MinCount = qt.MetricMinCount{Min: 3}
							}
						}
					case "measured", "measured-sum":
						for i := range request.Metrics {
							if len(request.Metrics[i].GroupBy) == 0 {
								continue
							}
							request.Metrics[i].MinCount = qt.MetricMinCount{Min: 3, Distinct: "conversation_id"}
							if budgets == "measured-sum" {
								request.Metrics[i].MinCount = qt.MetricMinCount{Min: 20, Sum: "gap"}
							}
						}
					case "top-min":
						for i := range request.Metrics {
							request.Metrics[i].GroupLimit = 1
							if len(request.Metrics[i].GroupBy) > 0 {
								request.Metrics[i].MinCount = qt.MetricMinCount{Min: 3, Distinct: "conversation_id"}
							}
						}
					case "cycle", "every":
						for i := range request.Metrics {
							if c := request.Metrics[i].DateGrouping; c != nil {
								copy := *c
								if budgets == "cycle" {
									copy.Interval = "hourOfDay"
								} else {
									copy.Interval, copy.Every = "hour", 6
								}
								request.Metrics[i].DateGrouping = &copy
							}
						}
					}
					log.reset(nil)
					got, gotErr := limited.Execute(context.Background(), db, request, qt.PlanOptions{})
					log.reset(declineDirect)
					want, wantErr := limited.Execute(context.Background(), db, request, qt.PlanOptions{})
					if !reflect.DeepEqual(got, want) || fmt.Sprint(gotErr) != fmt.Sprint(wantErr) {
						t.Fatalf("shared:\n%#v / %v\nSQL:\n%#v / %v", got.Metrics, gotErr, want.Metrics, wantErr)
					}
				})
			}
		})
	}
}
