package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// countingHost records every count it is offered and answers through the
// executor's own statement unless answer is set.
type countingHost struct {
	offered []qt.PopulationCount
	answer  func(qt.PopulationCount) (int64, bool)
	err     error
}

func (h *countingHost) CountPopulation(ctx context.Context, tx *sql.Tx, p qt.PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
	h.offered = append(h.offered, p)
	if h.err != nil {
		return 0, h.err
	}
	if h.answer != nil {
		if n, ok := h.answer(p); ok {
			return n, nil
		}
	}
	// The described statement is the executor's: running it directly in the
	// same transaction gives the count the executor would.
	var direct int64
	if err := tx.QueryRowContext(ctx, p.SQL, p.Args...).Scan(&direct); err != nil {
		return 0, err
	}
	n, err := count(ctx)
	if err == nil && n != direct {
		return 0, errors.New("count and statement disagree")
	}
	return n, err
}

func TestV3PopulationCounterParity(t *testing.T) {
	db, d, o := ungroupedV3(t, 400)
	host := &countingHost{}
	counted := d
	counted.PopulationCounter = host
	for name, q := range ungroupedCases() {
		t.Run(name, func(t *testing.T) {
			want, err := executeV3In(db, d, q, o)
			if err != nil {
				t.Fatal(err)
			}
			host.offered = nil
			got, err := executeV3In(db, counted, q, o)
			if err != nil || got != want {
				t.Fatalf("with counter %s err=%v\nwithout %s", got, err, want)
			}
			if _, err = executeV3In(db, counted, q, o); err != nil {
				t.Fatal(err)
			}
			if len(host.offered) != 2 {
				t.Fatalf("counter consulted %d times for two executions", len(host.offered))
			}
			first, second := host.offered[0], host.offered[1]
			if first.Key == "" || first.Key != second.Key || first.SQL != second.SQL || !reflect.DeepEqual(first.Args, second.Args) {
				t.Fatalf("repeated execution changed its count: %+v\n%+v", first, second)
			}
			described, _ := json.Marshal(first.Where)
			requested, _ := json.Marshal(q.Result.Where)
			if len(q.Result.Where) == 0 && len(first.Where) == 0 {
				described, requested = nil, nil
			}
			if string(described) != string(requested) || first.Now.UnixMilli() != q.Now {
				t.Fatalf("count description %s at %v, request %s at %d", described, first.Now, requested, q.Now)
			}
		})
	}
	// Grouped executions count their own staged or direct populations.
	host.offered = nil
	grouped := ungroupedRequest(qt.WireQuery{Select: []string{"k", "rows"}, Limit: 5})
	grouped.Grouping = &qt.GroupingDefinition{Keys: []string{"k"}, Summaries: []qt.SummaryColumn{{ID: "rows", Op: "count"}}}
	if _, err := executeV3In(db, counted, grouped, o); err != nil || len(host.offered) != 0 {
		t.Fatalf("grouped execution consulted the counter %d times: %v", len(host.offered), err)
	}
}

func TestV3PopulationCounterAnswers(t *testing.T) {
	db, d, o := ungroupedV3(t, 120)
	q := ungroupedCases()["text sort and filter"]
	plain := executeV3(t, db, d, q, o)
	cache := map[string]int64{}
	host := &countingHost{answer: func(p qt.PopulationCount) (int64, bool) { n, ok := cache[p.Key]; return n, ok }}
	counted := d
	counted.PopulationCounter = host
	// The host's answer is the total: the executor does not recount it.
	first := executeV3(t, db, counted, q, o)
	cache[host.offered[0].Key] = first.Total + 1000
	answered := executeV3(t, db, counted, q, o)
	if first.Total != plain.Total || answered.Total != plain.Total+1000 || answered.SourceTotal != answered.Total || !reflect.DeepEqual(ids(answered), ids(plain)) {
		t.Fatalf("plain %d, first %d, answered %d/%d", plain.Total, first.Total, answered.Total, answered.SourceTotal)
	}
	// A failing or impossible answer fails the execution.
	host.answer = func(qt.PopulationCount) (int64, bool) { return -1, true }
	var diag *qt.PlanDiagnostic
	if _, err := executeV3In(db, counted, q, o); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeDataset {
		t.Fatal("negative count", err)
	}
	host.err = errors.New("host: generation unavailable")
	if _, err := executeV3In(db, counted, q, o); err == nil || !strings.Contains(err.Error(), "generation unavailable") {
		t.Fatal("counter error", err)
	}
	// The executor's own count fails the execution when the counter
	// returns its error.
	counted.PopulationCounter = qt.PopulationCounterFunc(func(ctx context.Context, _ *sql.Tx, _ qt.PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		return count(cancelled)
	})
	if _, err := executeV3In(db, counted, q, o); !errors.Is(err, context.Canceled) {
		t.Fatal("count error", err)
	}
}

func TestV3PopulationCountKeys(t *testing.T) {
	db, d, o := ungroupedV3(t, 60)
	host := &countingHost{}
	d.PopulationCounter = host
	describe := func(d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) qt.PopulationCount {
		t.Helper()
		host.offered = nil
		executeV3(t, db, d, q, o)
		if len(host.offered) != 1 {
			t.Fatalf("offered %d counts", len(host.offered))
		}
		return host.offered[0]
	}
	where := func(terms ...qt.WhereTerm) qt.QueryRequestV3 {
		return ungroupedRequest(qt.WireQuery{Select: []string{"id"}, Where: terms, Limit: 3})
	}
	at := func(q qt.QueryRequestV3, now time.Time) qt.QueryRequestV3 { q.Now = now.UnixMilli(); return q }
	noon := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	later := noon.Add(time.Minute)

	base := describe(d, where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"}), o)
	// Page shape, order and the clock do not change an absolute count.
	reshaped := where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"})
	reshaped.Result.Select, reshaped.Result.OrderBy, reshaped.Result.Limit, reshaped.Result.Offset = []string{"id", "note"}, []qt.OrderBy{{Field: "n", Dir: "desc"}}, 10, 4
	if got := describe(d, at(reshaped, later), o); got.Key != base.Key {
		t.Fatal("page shape or clock changed an absolute count's key")
	}

	keys := map[string]string{"base": base.Key}
	distinct := func(name string, p qt.PopulationCount) {
		t.Helper()
		for other, key := range keys {
			if key == p.Key {
				t.Fatalf("%s shares a key with %s", name, other)
			}
		}
		keys[name] = p.Key
	}
	distinct("filter value", describe(d, where(qt.WhereTerm{Field: "e", Op: "=", Value: "mid"}), o))
	distinct("unfiltered", describe(d, where(), o))

	// Scope, dataset and source arguments separate otherwise equal statements.
	other := d
	other.Scope = "two"
	distinct("scope", describe(other, where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"}), o))
	other = d
	other.Dataset = "direct-copy"
	distinct("dataset", describe(other, where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"}), o))
	other = d
	other.SourceArgs = []any{"two"}
	distinct("source args", describe(other, where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"}), o))
	identified := o
	identified.Identity = "actor-2"
	distinct("identity", describe(d, where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"}), identified))

	// A relative filter keys on the request's clock, which every count
	// reports.
	recent := where(qt.WhereTerm{Field: "at", Op: ">=", Value: "-14d"})
	relative := describe(d, at(recent, noon), o)
	if !relative.Now.Equal(noon) {
		t.Fatalf("relative count clock %v", relative.Now)
	}
	distinct("relative", relative)
	if again := describe(d, at(recent, noon), o); again.Key != relative.Key {
		t.Fatal("same clock changed a relative count's key")
	}
	distinct("relative later", describe(d, at(recent, later), o))

	// A computed filter keys on the definition revisions it reaches.
	computed := where(qt.WhereTerm{Field: "@computed/double", Op: ">", Value: "2"})
	distinct("computed", describe(d, computed, o))
	resolver := o.Resolver
	bumped := o
	bumped.Resolver = qt.DefinitionResolverFunc(func(ctx context.Context, id string) (qt.ComputedColumn, error) {
		c, err := resolver.ResolveComputed(ctx, id)
		c.Revision = "2"
		return c, err
	})
	computed.ExpectedRevisions = map[string]string{"double": "2", "inv": "2", "big": "2"}
	distinct("computed revision", describe(d, computed, bumped))

	// A predicate relation is part of the statement, so its SQL and
	// arguments separate otherwise equal filters.
	related := func(tenant string) qt.QueryDatasetV3 {
		r := d
		r.PredicateRelations = qt.SQLitePredicateRelationsFunc(func(_ context.Context, _ *sql.Tx, p qt.SQLitePredicate) (qt.SQLitePredicateRelation, bool, error) {
			if p.Field != "e" {
				return qt.SQLitePredicateRelation{}, false, nil
			}
			return qt.SQLitePredicateRelation{SQL: "SELECT id FROM direct WHERE tenant=? AND e=?", Args: []any{tenant, p.Value}}, true, nil
		})
		return r
	}
	low := where(qt.WhereTerm{Field: "e", Op: "=", Value: "low"})
	relation := describe(related("one"), low, o)
	if !strings.Contains(relation.SQL, "tenant=?") {
		t.Fatalf("relation not compiled into the count: %s", relation.SQL)
	}
	distinct("relation", relation)
	distinct("relation args", describe(related("two"), low, o))
}

// The counter's description is its own: a host that edits it cannot change
// the filter the executor pages and reduces with.
func TestV3PopulationCountIsACopy(t *testing.T) {
	db, d, o := ungroupedV3(t, 60)
	q := ungroupedRequest(qt.WireQuery{Select: []string{"id", "e"}, Where: []qt.WhereTerm{
		{Field: "e", Op: "=", Value: "low"},
		{Any: []qt.WhereClause{{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "alpha"}}}, {Field: "k", Op: "=", Value: "beta"}}, SetFilter: &qt.SetFilterMetadata{ID: "k", Mode: "any", Values: []string{"alpha", "beta"}}},
	}, Limit: 50})
	plain := executeV3(t, db, d, q, o)
	request, _ := json.Marshal(q)
	d.PopulationCounter = qt.PopulationCounterFunc(func(ctx context.Context, _ *sql.Tx, p qt.PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
		p.Where[0].Value = "mid"
		p.Where[1].Any[0].All[0].Value = "gamma"
		p.Where[1].Any[1].Value = "gamma"
		p.Where[1].SetFilter.Values[0] = "gamma"
		p.Args[0] = "two"
		return count(ctx)
	})
	got := executeV3(t, db, d, q, o)
	if after, _ := json.Marshal(q); string(after) != string(request) {
		t.Fatalf("counter changed the request:\n%s\n%s", request, after)
	}
	if got.Total != plain.Total || !reflect.DeepEqual(got.Rows, plain.Rows) {
		t.Fatalf("counter changed the execution: %d %v\n%d %v", got.Total, got.Rows, plain.Total, plain.Rows)
	}
}

// Mutable source arguments are copied into the description too: editing the
// described bytes changes neither the count nor the dataset's arguments.
func TestV3PopulationCountCopiesArguments(t *testing.T) {
	db, d, o := ungroupedV3(t, 60)
	d.SourceSQL, d.SourceArgs = "SELECT * FROM direct WHERE tenant=CAST(?1 AS TEXT)", []any{[]byte("one")}
	q := ungroupedRequest(qt.WireQuery{Select: []string{"id"}, Limit: 50})
	plain := executeV3(t, db, d, q, o)
	d.PopulationCounter = qt.PopulationCounterFunc(func(ctx context.Context, _ *sql.Tx, p qt.PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
		copy(p.Args[0].([]byte), "two")
		return count(ctx)
	})
	got := executeV3(t, db, d, q, o)
	if string(d.SourceArgs[0].([]byte)) != "one" || got.Total != plain.Total || !reflect.DeepEqual(got.Rows, plain.Rows) {
		t.Fatalf("source args %q, total %d (plain %d)", d.SourceArgs[0], got.Total, plain.Total)
	}
}

// Arguments key by the values they bind: one pointer whose value changes
// keys apart, and a new pointer to an equal value keys alike.
func TestV3PopulationCountKeysBoundValues(t *testing.T) {
	db, d, o := ungroupedV3(t, 60)
	host := &countingHost{}
	d.PopulationCounter = host
	q := ungroupedRequest(qt.WireQuery{Select: []string{"id"}, Limit: 3})
	tenant := "one"
	describe := func(arg any) (qt.PopulationCount, int64) {
		t.Helper()
		host.offered = nil
		d.SourceArgs = []any{arg}
		total := executeV3(t, db, d, q, o).Total
		return host.offered[0], total
	}
	one, oneTotal := describe(&tenant)
	tenant = "two"
	two, twoTotal := describe(&tenant)
	if oneTotal == twoTotal || one.Key == two.Key {
		t.Fatalf("pointer value changed the count %d→%d but kept key %v", oneTotal, twoTotal, one.Key == two.Key)
	}
	again := "one"
	if p, _ := describe(&again); p.Key != one.Key {
		t.Fatal("an equal value behind a new pointer changed the key")
	}
	if p, _ := describe("one"); p.Key != one.Key {
		t.Fatal("a value and a pointer to it bind alike but keyed apart")
	}
}
