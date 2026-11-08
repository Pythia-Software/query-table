package querytable

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"
)

// PopulationCount is the exact population count an ungrouped QueryDatasetV3
// execution needs before it reads its page and metrics. The executor reports
// it as the result's total and sourceTotal, and as the value of whole-population
// count() metrics. The counter receives its own copy: changing it does not
// change the execution.
type PopulationCount struct {
	// Where is the request's canonical result filter.
	Where []WhereTerm
	// Now is the evaluation clock that relative values in Where (such as
	// "-30d") resolve against.
	Now time.Time
	// SQL and Args are the statement the executor runs to count.
	SQL  string
	Args []any
	// Key digests the dialect, scope, dataset, expression profile,
	// PlanOptions.Identity, SQL, Args and the revisions of the computed
	// definitions SQL reaches. Equal keys mean equal statements, not equal
	// counts: Key does not capture the data SQL reads (including temporary
	// tables and predicate-relation tables) or connection state that changes
	// its result (such as the local time zone SQLite's 'localtime' uses).
	Key string
}

// PopulationCounter lets a host answer an ungrouped execution's population
// count, for example from a cache of earlier counts or from a maintained
// rollup. It is consulted once per execution with that execution's context
// and transaction, and may be consulted concurrently by executions in other
// transactions. count runs SQL in tx and returns its exact result; the
// counter may call it, or answer without it, but must return the exact
// number of rows SQL would return in tx. The executor does not check the
// answer beyond rejecting a negative count. A returned error fails the
// execution.
//
// A host that reuses counts across executions owns their validity. Pair Key
// with a data generation read in tx under snapshot isolation (so it describes
// the rows the count reads), that advances on every write to any table SQL
// reads, and with any authorization or connection state that SourceSQL and
// its arguments do not encode. Do not reuse counts for a source that reads
// rows staged per request. A host that answers from Where instead of SQL
// reimplements its predicates and must match their semantics exactly.
// Grouped executions, distinct values and staged scratch budgets do not
// consult the counter.
type PopulationCounter interface {
	CountPopulation(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error)
}

// PopulationCounterFunc adapts a function to PopulationCounter.
type PopulationCounterFunc func(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error)

func (f PopulationCounterFunc) CountPopulation(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
	return f(ctx, tx, p, count)
}

// newPopulationCount describes plan, a compiled COUNT(*) over where.
// Relative datetime values compile to bound instants, so plan.Fingerprint
// already separates counts taken against different clocks.
func (d QueryDatasetV3) newPopulationCount(where []WhereTerm, plan SQLPlan, o PlanOptions) PopulationCount {
	p := PopulationCount{Where: cloneWhereTerms(where), Now: o.Now, SQL: plan.SQL, Args: append([]any{}, plan.Args...)}
	h := sha256.New()
	// plan.Fingerprint covers the profile, PlanOptions.Identity, the complete
	// statement, its arguments and the revisions of its dependencies.
	fmt.Fprintf(h, "population-count/1\x00%q\x00%q\x00%q\x00%s", d.Dialect, d.Scope, d.Dataset, plan.Fingerprint)
	p.Key = hex.EncodeToString(h.Sum(nil))
	return p
}

// cloneWhereTerms deep-copies where, so a host cannot change the filter the
// executor goes on to page and reduce with.
func cloneWhereTerms(where []WhereTerm) []WhereTerm {
	if where == nil {
		return nil
	}
	out := make([]WhereTerm, len(where))
	for i, term := range where {
		out[i] = term
		out[i].Any = cloneWhereClauses(term.Any)
		if term.SetFilter != nil {
			metadata := *term.SetFilter
			if metadata.Values != nil {
				metadata.Values = append(make([]string, 0, len(metadata.Values)), metadata.Values...)
			}
			out[i].SetFilter = &metadata
		}
	}
	return out
}

func cloneWhereClauses(clauses []WhereClause) []WhereClause {
	if clauses == nil {
		return nil
	}
	out := make([]WhereClause, len(clauses))
	for i, clause := range clauses {
		out[i] = clause
		out[i].All = cloneWhereClauses(clause.All)
	}
	return out
}

func (d QueryDatasetV3) runPopulationCount(ctx context.Context, tx *sql.Tx, where []WhereTerm, plan SQLPlan, o PlanOptions) (int64, error) {
	count := func(ctx context.Context) (int64, error) {
		var total int64
		err := tx.QueryRowContext(ctx, plan.SQL, plan.Args...).Scan(&total)
		return total, err
	}
	if d.PopulationCounter == nil {
		return count(ctx)
	}
	total, err := d.PopulationCounter.CountPopulation(ctx, tx, d.newPopulationCount(where, plan, o), count)
	if err != nil {
		return 0, err
	}
	if total < 0 {
		return 0, diagnostic(ErrorCodeDataset, "population counter returned a negative count")
	}
	return total, nil
}
