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

const (
	sourceProofMarker = "SELECT COUNT(*),"
	populationMarker  = "SELECT COUNT(*) FROM (SELECT 1 FROM"
)

// proofQuery is the cross-field batch plus every plain integer domain, and
// members whose sorting, top-N and minimum counts stay in their own consumer
// plans. A formula and a metric predicate form their own reductions.
func proofQuery(grouped bool) qt.MetricQuery {
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
			// A measured minimum adds a reduction the proof must also cover.
			qt.AggSpec{ID: "summed", Op: "count", GroupBy: by, MinCount: qt.MetricMinCount{Min: 40, Sum: "n4"}})
	}
	q.Metrics = append(q.Metrics,
		qt.AggSpec{ID: "ratio", Expression: "SUM([n0])/COUNT()", GroupBy: by, Where: []qt.WhereTerm{{Field: "n1", Op: ">", Value: "2"}}},
		qt.AggSpec{ID: "large", Op: "sum", Field: "n7", GroupBy: by, Where: []qt.WhereTerm{{Field: "n1", Op: ">", Value: "2"}}})
	return q
}

func withProofs(d qt.SQLiteV2Dataset, generation string, proofs *qt.SQLiteSourceProofs) qt.SQLiteV2Dataset {
	d.SourceGeneration, d.SourceProofs = generation, proofs
	return d
}

// trustedReductions counts fused integer reductions without per-row proofs.
func trustedReductions(log *statementLog) int {
	log.mu.Lock()
	defer log.mu.Unlock()
	n := 0
	for _, query := range log.seen {
		if strings.HasPrefix(query, "CREATE TEMP TABLE _qt_reduction_") && strings.Contains(query, "qt_integer_input") && !strings.Contains(query, "ELSE 0.0 END") {
			n++
		}
	}
	return n
}

func TestV2SourceProofsMatchPerExecutionProofs(t *testing.T) {
	for _, grouped := range []bool{false, true} {
		for _, where := range [][]qt.WhereTerm{nil, {{Field: "n0", Op: ">", Value: "3"}}} {
			log := &statementLog{}
			db, plain := crossFieldDataset(t, log)
			d := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
			q := proofQuery(grouped)
			q.Where = where
			want, err := plain.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			for run := 0; run < 2; run++ {
				log.reset(nil)
				got := crossFieldParity(t, db, d, q, qt.PlanOptions{})
				if !reflect.DeepEqual(got.Metrics.Metrics, want.Metrics.Metrics) {
					t.Fatalf("grouped=%t where=%v run=%d: proofs changed results\ngot %#v\nwant %#v", grouped, where, run, got.Metrics.Metrics, want.Metrics.Metrics)
				}
				for _, m := range got.Metrics.Metrics {
					if m.Error != "" {
						t.Fatal(m)
					}
				}
			}
			// The first execution proved the source; later ones reuse the proof.
			log.reset(nil)
			if _, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
				t.Fatal(err)
			}
			if n := log.count(sourceProofMarker); n != 0 {
				t.Fatalf("reproved a cached source %d times", n)
			}
			if trustedReductions(log) != 1 {
				t.Fatalf("grouped=%t where=%v: wanted one trusted reduction:\n%s", grouped, where, strings.Join(log.seen, "\n"))
			}
			// Unfiltered requests reuse the source count. Filtered requests take
			// theirs from the fused reduction, since the source fits the budget.
			if n := log.count(populationMarker); n != 0 {
				t.Fatalf("grouped=%t where=%v: counted the population %d times", grouped, where, n)
			}
		}
	}
}

func TestV2SourceProofsFollowGenerations(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	proofs := &qt.SQLiteSourceProofs{}
	q := proofQuery(true)
	for i, change := range []struct {
		sql     string
		trusted bool
	}{
		{"", true},
		{"UPDATE source SET n0=-5,n1=NULL WHERE id='00000001'", true}, // signed and NULL values within the bound
		{"UPDATE source SET n0=9007199254740991 WHERE id='00000002'", false},
		{"UPDATE source SET n0=1 WHERE id='00000002'", true},
		{"UPDATE source SET n2='12' WHERE id='00000003'", false}, // numeric text is never summed as an integer
		{"UPDATE source SET n2=0.5 WHERE id='00000003'", false},
		{"UPDATE source SET n2=X'3132' WHERE id='00000003'", false},
		{"UPDATE source SET n2=-9223372036854775808 WHERE id='00000003'", false},
		{"UPDATE source SET n2=3 WHERE id='00000003'", true},
		// The nonnegative proof's SUM overflows; the signed proof declines.
		{"UPDATE source SET n3=9223372036854775807 WHERE id IN ('00000001','00000002')", false},
		{"UPDATE source SET n3=4 WHERE id IN ('00000001','00000002')", true},
	} {
		if change.sql != "" {
			if _, err := db.Exec(change.sql); err != nil {
				t.Fatal(err)
			}
		}
		d := withProofs(plain, fmt.Sprint("g", i), proofs)
		want, err := plain.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for run := 0; run < 2; run++ {
			log.reset(nil)
			got, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Metrics.Metrics, want.Metrics.Metrics) {
				t.Fatalf("%q: proofs changed results\ngot %#v\nwant %#v", change.sql, got.Metrics.Metrics, want.Metrics.Metrics)
			}
			if trusted := trustedReductions(log) == 1; trusted != change.trusted {
				t.Fatalf("%q run %d: trusted=%t", change.sql, run, trusted)
			}
			if run == 1 && log.count(sourceProofMarker) != 0 {
				t.Fatalf("%q: a declined proof is cached too", change.sql)
			}
		}
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
	}
}

// A host that fails to advance its generation breaks the contract. Values
// SQLite's SUM reports as REAL are still caught by the result type backstop.
func TestV2SourceProofsStaleGenerationBackstop(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	d := withProofs(plain, "stale", &qt.SQLiteSourceProofs{})
	q := proofQuery(true)
	if _, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE source SET n0=0.5 WHERE id='00000001'"); err != nil {
		t.Fatal(err)
	}
	want, err := plain.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Metrics.Metrics, want.Metrics.Metrics) {
		t.Fatalf("got %#v\nwant %#v", got.Metrics.Metrics, want.Metrics.Metrics)
	}
}

func TestV2SourceProofsDecline(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	q := proofQuery(true)
	// No generation, or no cache: nothing is proven or cached.
	for _, d := range []qt.SQLiteV2Dataset{withProofs(plain, "", &qt.SQLiteSourceProofs{}), withProofs(plain, "g1", nil)} {
		log.reset(nil)
		if _, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
			t.Fatal(err)
		}
		if log.count(sourceProofMarker) != 0 || trustedReductions(log) != 0 {
			t.Fatal("proved a source without a host generation and cache")
		}
	}
	// Host functions, here hidden in a view, are never proven per generation.
	if _, err := db.Exec(`CREATE VIEW opaque_source AS SELECT id,k,tenant,qt_test_metric_probe(n0) AS n0,n1,n2,n3,n4,n5,n6,n7,n8 FROM source`); err != nil {
		t.Fatal(err)
	}
	opaque := plain
	opaque.SourceSQL = "SELECT * FROM opaque_source WHERE tenant=?1"
	d := withProofs(opaque, "g1", &qt.SQLiteSourceProofs{})
	for run := 0; run < 2; run++ {
		log.reset(nil)
		crossFieldParity(t, db, d, q, qt.PlanOptions{})
		if log.count(sourceProofMarker) != 0 || trustedReductions(log) != 0 {
			t.Fatal("proved an opaque source")
		}
	}
	// A source larger than the population budget is not proven. Requests
	// still count their own population and keep the budget.
	limited := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
	limited.MaxPopulation = 20
	filtered := q
	filtered.Where = []qt.WhereTerm{{Field: "n0", Op: ">", Value: "80"}}
	for run := 0; run < 2; run++ {
		log.reset(nil)
		crossFieldParity(t, db, limited, filtered, qt.PlanOptions{})
		if trustedReductions(log) != 0 || log.count(populationMarker) == 0 {
			t.Fatal("trusted a source beyond the population budget")
		}
		if run == 1 && log.count(sourceProofMarker) != 0 {
			t.Fatal("reproved an oversized source")
		}
		if _, err := limited.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err == nil || !strings.Contains(err.Error(), "matching population exceeds host budget") {
			t.Fatal("population budget", err)
		}
	}
	// Facts are scoped to the authorized source and its arguments.
	denied := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
	if _, err := denied.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	denied.SourceArgs = []any{"denied"}
	log.reset(nil)
	got := crossFieldParity(t, db, denied, q, qt.PlanOptions{})
	if log.count(sourceProofMarker) != 1 || got.Metrics.Metrics[0].ProcessedRows != 1 {
		t.Fatal("reused facts across source arguments", got.Metrics.Metrics[0])
	}
}

func TestV2SourceProofsPopulationAndErrors(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	d := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
	warm := proofQuery(true)
	if _, err := d.ExecuteV2(context.Background(), db, nil, &warm, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	where := []qt.WhereTerm{{Field: "n0", Op: ">", Value: "50"}}
	var matching int64
	if err := db.QueryRow("SELECT COUNT(*) FROM source WHERE tenant='allowed' AND n0>50").Scan(&matching); err != nil {
		t.Fatal(err)
	}
	// A request no fused reduction serves still counts its population, when
	// and only if a metric needs it.
	single := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Where: where, Metrics: []qt.AggSpec{{ID: "ratio", Expression: "SUM([n0])/COUNT()", GroupBy: []string{"k"}}}}
	log.reset(nil)
	got, err := d.ExecuteV2(context.Background(), db, nil, &single, qt.PlanOptions{})
	if err != nil || got.Metrics.Metrics[0].ProcessedRows != matching || log.count(populationMarker) != 1 {
		t.Fatal(got, err, log.count(populationMarker))
	}
	invalid := single
	invalid.Metrics = []qt.AggSpec{{ID: "bad", Op: "sum", Field: "missing"}}
	log.reset(nil)
	got, err = d.ExecuteV2(context.Background(), db, nil, &invalid, qt.PlanOptions{})
	if err != nil || got.Metrics.Metrics[0].Error == "" || log.count(populationMarker) != 0 {
		t.Fatal(got, err)
	}
	// A deferred count that fails is a request error, as the preflight was.
	log.reset(func(query string) error {
		if strings.HasPrefix(query, populationMarker) {
			return errors.New("population failure")
		}
		return nil
	})
	if _, err := d.ExecuteV2(context.Background(), db, nil, &single, qt.PlanOptions{}); err == nil || !strings.Contains(err.Error(), "population failure") {
		t.Fatal("deferred population failure", err)
	}
	// The fused reduction counts the population for a filtered batch, and
	// every member, including a failing one, keeps its own result.
	batch := proofQuery(true)
	batch.Where = where
	batch.Metrics = append(batch.Metrics, qt.AggSpec{ID: "bad", Op: "sum", Field: "missing"})
	got, err = d.ExecuteV2(context.Background(), db, nil, &batch, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Metrics.Metrics {
		if (m.ID == "bad") != (m.Error != "") || m.ID != "bad" && m.ProcessedRows != matching {
			t.Fatal(m)
		}
	}
	// Group budgets still apply to every execution.
	log.reset(nil)
	limited := d
	limited.MaxGroups = 1
	got, err = limited.ExecuteV2(context.Background(), db, nil, &warm, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Metrics.Metrics {
		if m.Error != "group population exceeds host budget" {
			t.Fatal(m)
		}
	}
}

func TestV2SourceProofsCancellation(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	d := withProofs(plain, "g1", &qt.SQLiteSourceProofs{})
	q := proofQuery(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log.reset(func(query string) error {
		if strings.Contains(query, sourceProofMarker) {
			cancel()
		}
		return nil
	})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := d.ExecuteV2In(ctx, tx, nil, &q, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal("proof cancellation", err)
	}
	assertNoReductions(t, tx)
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Cancellation cached nothing: the next execution proves the source.
	log.reset(nil)
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
	if log.count(sourceProofMarker) != 1 || trustedReductions(log) != 1 {
		t.Fatal("cancelled proof was cached")
	}
}

func TestV2SourceProofsConcurrentExecutions(t *testing.T) {
	log := &statementLog{}
	db, plain := crossFieldDataset(t, log)
	db.SetMaxOpenConns(4)
	proofs := &qt.SQLiteSourceProofs{}
	q := proofQuery(true)
	want, err := plain.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d := withProofs(plain, fmt.Sprint("g", i%3), proofs)
			got, err := d.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
			if err == nil && !reflect.DeepEqual(got.Metrics.Metrics, want.Metrics.Metrics) {
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
