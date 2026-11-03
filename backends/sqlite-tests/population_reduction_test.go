package sqlitetests

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Ported from the removed source-proof cache tests: the behaviour that never
// depended on cached proofs (batch parity across storage changes, population
// counts, isolation, budgets, argument scoping and concurrency).

// proofQuery is the cross-field batch plus every plain integer domain, and
// members whose sorting, top-N and minimum counts stay in their own consumer
// plans. A formula and a metric predicate form their own reductions.
func proofQuery(grouped bool) qt.QueryRequestV3 {
	q := crossFieldQuery(grouped)
	var by []string
	if grouped {
		by = []string{"k"}
	}
	for _, expression := range []string{"AVG([n0])", "MIN([n1])", "MAX([n2])", "COUNT_DISTINCT([n3])"} {
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: fmt.Sprintf("expr%d", len(q.Metrics)), Expression: expression, GroupBy: by})
	}
	if grouped {
		q.Metrics = append(q.Metrics,
			qt.AggSpec{ID: "top", Op: "sum", Field: "n5", GroupBy: by, Sort: []qt.MetricSort{{Key: "value", Dir: "asc"}}, GroupLimit: 2},
			qt.AggSpec{ID: "frequent", Op: "sum", Field: "n6", GroupBy: by, MinCount: qt.MetricMinCount{Min: 7}},
			qt.AggSpec{ID: "summed", Op: "count", GroupBy: by, MinCount: qt.MetricMinCount{Min: 40, Sum: "n4"}})
	}
	q.Metrics = append(q.Metrics,
		qt.AggSpec{ID: "ratio", Expression: "SUM([n0])/COUNT()", GroupBy: by, Where: []qt.WhereTerm{{Field: "n1", Op: ">", Value: "2"}}},
		qt.AggSpec{ID: "large", Op: "sum", Field: "n7", GroupBy: by, Where: []qt.WhereTerm{{Field: "n1", Op: ">", Value: "2"}}})
	return q
}

// From TestV2SourceProofsFollowGenerations: storage changes that switch the
// integer reduction on and off keep the batch equal to each metric alone.
func TestV2IntegerStorageChangesKeepBatchParity(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := proofQuery(true)
	for _, change := range []string{
		"",
		"UPDATE source SET n0=-5,n1=NULL WHERE id='00000001'",
		"UPDATE source SET n0=9007199254740991 WHERE id='00000002'",
		"UPDATE source SET n0=1 WHERE id='00000002'",
		"UPDATE source SET n2='12' WHERE id='00000003'",
		"UPDATE source SET n2=0.5 WHERE id='00000003'",
		"UPDATE source SET n2=X'3132' WHERE id='00000003'",
		"UPDATE source SET n2=-9223372036854775808 WHERE id='00000003'",
		"UPDATE source SET n2=3 WHERE id='00000003'",
		"UPDATE source SET n3=9223372036854775807 WHERE id IN ('00000001','00000002')",
		"UPDATE source SET n3=4 WHERE id IN ('00000001','00000002')",
	} {
		if change != "" {
			if _, err := db.Exec(change); err != nil {
				t.Fatal(err)
			}
		}
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
}

// From TestV2SourceProofsDecline: opaque sources keep parity, and results are
// scoped to the authorized source arguments.
func TestV2OpaqueSourcesAndSourceArguments(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	q := proofQuery(true)
	if _, err := db.Exec(`CREATE VIEW opaque_source AS SELECT id,k,tenant,qt_test_metric_probe(n0) AS n0,n1,n2,n3,n4,n5,n6,n7,n8 FROM source`); err != nil {
		t.Fatal(err)
	}
	opaque := d
	opaque.SourceSQL = "SELECT * FROM opaque_source WHERE tenant=?1"
	crossFieldParity(t, db, opaque, q, qt.PlanOptions{})
	if got := crossFieldParity(t, db, d, q, qt.PlanOptions{}); got.Metrics[0].ProcessedRows != 30 {
		t.Fatal(got.Metrics[0])
	}
	denied := d
	denied.SourceArgs = []any{"denied"}
	if got := crossFieldParity(t, db, denied, q, qt.PlanOptions{}); got.Metrics[0].ProcessedRows != 1 {
		t.Fatal("results crossed source arguments", got.Metrics[0])
	}
}

// From TestV2SourceProofsPopulationAndErrors.
func TestV2PopulationCountAndErrors(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	where := []qt.WhereTerm{{Field: "n0", Op: ">", Value: "50"}}
	var matching int64
	if err := db.QueryRow("SELECT COUNT(*) FROM source WHERE tenant='allowed' AND n0>50").Scan(&matching); err != nil {
		t.Fatal(err)
	}
	single := metricsV3(where, nil, 0, 0, qt.AggSpec{ID: "ratio", Expression: "SUM([n0])/COUNT()", GroupBy: []string{"k"}})
	log.reset(nil)
	got, err := d.Execute(context.Background(), db, single, qt.PlanOptions{})
	if err != nil || got.Metrics[0].ProcessedRows != matching || log.count(populationMarker) != 1 {
		t.Fatal(got, err, log.count(populationMarker))
	}
	// An invalid clause fails only its metric. v3 counts the population before
	// any metric runs, so the count is sent even then (v2 skipped it).
	invalid := single
	invalid.Metrics = []qt.AggSpec{{ID: "bad", Op: "sum", Field: "k"}}
	log.reset(nil)
	got, err = d.Execute(context.Background(), db, invalid, qt.PlanOptions{})
	if err != nil || got.Metrics[0].Error == "" || log.count(populationMarker) != 1 {
		t.Fatal(got, err)
	}
	// A population count that fails is a request error.
	log.reset(func(query string) error {
		if strings.Contains(query, populationMarker) {
			return errors.New("population failure")
		}
		return nil
	})
	if _, err := d.Execute(context.Background(), db, single, qt.PlanOptions{}); err == nil || !strings.Contains(err.Error(), "population failure") {
		t.Fatal("population failure", err)
	}
	log.reset(nil)
	// Every member of a filtered batch, including a failing one, keeps its
	// own result.
	batch := proofQuery(true)
	batch.Result.Where = where
	batch.Metrics = append(batch.Metrics, qt.AggSpec{ID: "bad", Op: "sum", Field: "k"})
	got, err = d.Execute(context.Background(), db, batch, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Metrics {
		if (m.ID == "bad") != (m.Error != "") || m.ID != "bad" && m.ProcessedRows != matching {
			t.Fatal(m)
		}
	}
	// Group budgets apply to every execution.
	limited := d
	limited.MaxGroups = 1
	got, err = limited.Execute(context.Background(), db, proofQuery(true), qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Metrics {
		if m.Error != "group population exceeds host budget" {
			t.Fatal(m)
		}
	}
}

// From TestV2SourceProofsConcurrentExecutions.
func TestV2ConcurrentExecutions(t *testing.T) {
	log := &statementLog{}
	db, d := crossFieldDataset(t, log)
	db.SetMaxOpenConns(4)
	q := proofQuery(true)
	want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err == nil && !reflect.DeepEqual(got.Metrics, want.Metrics) {
				err = fmt.Errorf("execution %d changed results", i)
			}
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}
