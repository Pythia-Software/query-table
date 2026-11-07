package querytable

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// PopulationCount is the exact population count an ungrouped QueryDatasetV3
// execution needs before it reads its page and metrics. The executor reports
// it as the result's total and sourceTotal and reuses it for metrics over the
// whole population. All fields are read-only.
type PopulationCount struct {
	Dialect, Scope, Dataset string
	// Where is the request's canonical result filter.
	Where []WhereTerm
	// SQL and Args are the statement the executor runs to count.
	SQL  string
	Args []any
	// Now is the request's evaluation clock when Where has a relative
	// datetime value, such as "-30d", and zero otherwise.
	Now time.Time
	// Revisions are the computed-definition revisions the statement reaches,
	// keyed by computed ID. Empty when the filter reads only base fields.
	Revisions map[string]string
	// Key digests the fields above together with PlanOptions.Identity and the
	// expression profile. Counts with equal keys run the same statement, so
	// they are equal whenever they read the same data. Key does not identify
	// the data snapshot (unless PlanOptions.Identity does).
	Key string
}

// PopulationCounter lets a host answer an ungrouped execution's population
// count, for example from a cache of earlier counts or from a maintained
// rollup. It is consulted once per execution with that execution's context
// and transaction. count runs SQL in tx and returns its exact result; the
// counter may call it, or answer without it, but must return the exact
// number of rows SQL would return in tx. A returned error fails the
// execution.
//
// A host that reuses counts across executions owns their validity: pair Key
// with a data generation read inside tx, and with any authorization state
// that SourceSQL and its arguments do not encode, and never reuse a count
// across a change to the rows SQL reads. Grouped executions, distinct values
// and staged scratch budgets do not consult the counter.
type PopulationCounter interface {
	CountPopulation(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error)
}

// PopulationCounterFunc adapts a function to PopulationCounter.
type PopulationCounterFunc func(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error)

func (f PopulationCounterFunc) CountPopulation(ctx context.Context, tx *sql.Tx, p PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
	return f(ctx, tx, p, count)
}

// newPopulationCount describes plan, a compiled COUNT(*) over where.
func (d QueryDatasetV3) newPopulationCount(where []WhereTerm, plan SQLPlan, o PlanOptions) PopulationCount {
	p := PopulationCount{Dialect: d.Dialect, Scope: d.Scope, Dataset: d.Dataset, Where: where, SQL: plan.SQL, Args: append([]any{}, plan.Args...), Revisions: map[string]string{}}
	if relativeWhere(where) {
		p.Now = o.Now
	}
	for _, dependency := range plan.Dependencies {
		if id, ok := strings.CutPrefix(dependency, "@computed/"); ok {
			p.Revisions[id] = plan.ResolvedRevisions[id]
		}
	}
	h := sha256.New()
	// plan.Fingerprint covers the profile, PlanOptions.Identity, the complete
	// statement, its arguments and the revisions of its dependencies.
	fmt.Fprintf(h, "population-count/1\x00%q\x00%q\x00%q\x00%s", d.Dialect, d.Scope, d.Dataset, plan.Fingerprint)
	if !p.Now.IsZero() {
		fmt.Fprintf(h, "\x00now=%d", p.Now.UnixNano())
	}
	p.Key = hex.EncodeToString(h.Sum(nil))
	return p
}

// relativeWhere reports whether any literal is a signed duration, which a
// datetime predicate resolves against the evaluation clock. It may also be
// true for a text literal that happens to look like one; that only narrows
// reuse.
func relativeWhere(where []WhereTerm) bool {
	for _, term := range where {
		for _, predicate := range term.Predicates() {
			if _, err := parseRelativeDuration(predicate.Value); err == nil {
				return true
			}
		}
	}
	return false
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
