package sqlitetests

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func directRequest() qt.QueryRequestV3 {
	q := groupedRequest()
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{
		{ID: "rows", Op: "count"}, {ID: "values", Op: "count", Field: "n0"},
		{ID: "total", Op: "sum", Field: "n0"}, {ID: "mean", Op: "avg", Field: "n0"},
		{ID: "low", Op: "min", Field: "n0"}, {ID: "high", Op: "max", Field: "n0"},
		{ID: "distinct", Op: "count_distinct", Field: "n0"},
	}}
	q.Source = qt.WireQuery{Limit: 1, Offset: 100}
	q.Result = qt.WireQuery{Select: []string{"k", "rows", "values", "total", "mean", "low", "high", "distinct"}, OrderBy: qt.OrderBys{{Field: "rows", Dir: "desc"}}, Limit: 2, Offset: 1}
	q.Metrics = []qt.AggSpec{{ID: "all", Op: "count"}, {ID: "shown", Op: "sum", Field: "rows", Scope: "shownRows"}}
	return q
}

// Declining EXPLAIN selects the original executor for the identical authorized
// source and request. No synthetic rows, rewritten summaries or cached results.
func declineDirect(query string) error {
	if strings.HasPrefix(query, "EXPLAIN ") {
		return errors.New("test: source proof unavailable")
	}
	return nil
}

func TestV3DirectGroupsMatchGeneralExecution(t *testing.T) {
	for _, mutation := range []string{
		"", "UPDATE source SET n0=-n0 WHERE id<'00000015'",
		"UPDATE source SET n0=NULL WHERE k IS NULL",
		"UPDATE source SET n0=0.1 WHERE tenant='allowed'", // exact decimal fallback
		"UPDATE source SET n0=CASE WHEN id='00000001' THEN 9007199254740991 WHEN id='00000002' THEN -9007199254740991 ELSE 0 END",
		"UPDATE source SET n0=9007199254740991",         // unsafe sum, safe extrema
		"UPDATE source SET n0='10' WHERE id='00000001'", // storage error, no SUM coercion
		"UPDATE source SET k=X'ff' WHERE id='00000001'",
		"UPDATE source SET id=CAST(X'ff' AS TEXT) WHERE id='00000001'",
		"DELETE FROM source WHERE tenant='allowed'",
	} {
		name := mutation
		if name == "" {
			name = "stored integers"
		}
		t.Run(name, func(t *testing.T) {
			log := &statementLog{}
			db, v2 := crossFieldDataset(t, log)
			if mutation != "" {
				if _, err := db.Exec(mutation); err != nil {
					t.Fatal(err)
				}
			}
			d := qt.QueryDatasetV3{Schema: v2.Schema, SourceSQL: v2.SourceSQL, SourceArgs: v2.SourceArgs, Dialect: "sqlite"}
			for _, having := range []bool{false, true} {
				q := directRequest()
				if having {
					q.Result.Where = []qt.WhereTerm{{Field: "rows", Op: ">", Value: "4"}}
				}
				log.reset(nil)
				got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if mutation == "" && log.count("qt_integer_input") == 0 {
					t.Fatal("direct reduction was not used")
				}
				log.reset(declineDirect)
				want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if !reflect.DeepEqual(got, want) || (err == nil) != (wantErr == nil) || err != nil && err.Error() != wantErr.Error() {
					t.Fatalf("candidate %#v / %v\ngeneral %#v / %v", got, err, want, wantErr)
				}
			}
		})
	}
}

func TestV3DirectGroupsBudgetsFailuresAndCleanup(t *testing.T) {
	log := &statementLog{}
	db, v2 := crossFieldDataset(t, log)
	d := qt.QueryDatasetV3{Schema: v2.Schema, SourceSQL: v2.SourceSQL, SourceArgs: v2.SourceArgs, Dialect: "sqlite"}
	q := directRequest()
	for _, budget := range []string{"population", "groups", "bytes", "success", "cancel", "statement failure", "cleanup failure"} {
		t.Run(budget, func(t *testing.T) {
			limited := d
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			injected := errors.New("injected direct failure")
			log.reset(func(query string) error {
				if strings.HasPrefix(query, "CREATE TEMP TABLE") && strings.Contains(query, "qt_integer_input") {
					if budget == "cancel" {
						cancel()
					}
					if budget == "statement failure" {
						return injected
					}
				}
				if budget == "cleanup failure" && strings.HasPrefix(query, "DROP TABLE IF EXISTS temp.") {
					return injected
				}
				return nil
			})
			switch budget {
			case "population":
				limited.MaxPopulation = 10
			case "groups":
				limited.MaxGroups = 2
			case "bytes":
				limited.MaxStagingBytes = 20
			}
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			out, err := limited.ExecuteIn(ctx, tx, q, qt.PlanOptions{})
			switch budget {
			case "success", "statement failure":
				if err != nil || out.SourceTotal != 30 {
					t.Fatalf("%#v: %v", out, err)
				}
			case "cancel":
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			case "cleanup failure":
				if !errors.Is(err, injected) || !reflect.DeepEqual(out, qt.QueryResultV3{}) {
					t.Fatalf("%#v: %v", out, err)
				}
			default:
				var diag *qt.PlanDiagnostic
				if !errors.As(err, &diag) || diag.Code != "resource_limit" {
					t.Fatal(err)
				}
			}
			if budget != "cleanup failure" && tempTables(t, tx) != 0 {
				t.Fatal("direct scratch leaked")
			}
			if budget == "success" {
				if err := tx.Commit(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestV3DirectGroupsRetainOpaqueSourceEvaluation(t *testing.T) {
	log := &statementLog{}
	db, v2 := crossFieldDataset(t, log)
	d := qt.QueryDatasetV3{Schema: v2.Schema, SourceSQL: "SELECT *,qt_test_metric_probe(n0) AS probed FROM source WHERE tenant=?1", SourceArgs: v2.SourceArgs, Dialect: "sqlite"}
	f := d.Schema.Fields["n0"]
	f.Expr = "r.probed"
	d.Schema.Fields["n0"] = f
	q := directRequest()
	log.reset(nil)
	metricProbeCalls.Store(0)
	got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if log.count("CREATE TEMP TABLE") == 0 || log.count("AS WITH qt_integer_input") != 0 {
		t.Fatal("opaque expression used direct reduction")
	}
	calls := metricProbeCalls.Load()
	log.reset(declineDirect)
	metricProbeCalls.Store(0)
	want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%#v / %v", got, err)
	}
	if calls == 0 || metricProbeCalls.Load() != calls {
		t.Fatal("opaque source evaluation changed")
	}
}
