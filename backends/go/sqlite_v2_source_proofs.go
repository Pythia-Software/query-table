package querytable

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
	"sync"
)

// SQLiteSourceProofs caches facts the adapter proved about a dataset's whole
// authorized source within one host data generation, so later executions in
// that generation need not prove them again row by row. Set it, with
// SQLiteV2Dataset.SourceGeneration, on every execution that may share it. The
// zero value is ready to use and safe for concurrent executions.
//
// Two facts are cached, each keyed by the generation, SourceSQL, SourceArgs
// and MaxPopulation, and proven by the adapter itself with one bounded scan of
// the unfiltered source (a second scan for fields with negative values):
//
//   - the source's row count, when it is within MaxPopulation. An unfiltered
//     request then reuses it instead of counting its population again, and a
//     filtered metric batch, which cannot exceed the budget, takes its count
//     from its fused reduction;
//   - for each numeric field expression a fused integer reduction consumes,
//     that every value is INTEGER or NULL and the absolute total of all values
//     is at most 9,007,199,254,740,991. Every filtered or grouped subset then
//     has exact, safe integer COUNT, SUM, AVG, MIN and MAX results, so the
//     reduction can use plain SQL aggregates without per-row checks.
//
// A field is proven only when SQLite's plan for the projection reads stored
// values (the same allowlist that permits direct reductions): functions,
// virtual tables and subqueries keep the per-execution checks. A source with
// more than MaxPopulation rows, values that are not safe integers, a failed
// proof statement or an inspection failure leave the ordinary checks in place.
// Nothing about a single request's subset is cached. Group keys, group and
// population budgets, revisions, filters and result types are still checked
// on every execution.
type SQLiteSourceProofs struct {
	mu      sync.Mutex
	entries map[string]*sqliteSourceFacts
}

// The cache is cleared when it reaches this many sources; entries for
// superseded generations are never consulted again.
const sqliteSourceProofEntries = 256

type sqliteSourceFacts struct {
	rows   int64 // whole-source row count, or -1 when not yet known
	fields map[string]bool
}

type sqliteSourceProofScope struct {
	cache      *SQLiteSourceProofs
	key        string
	source     string
	args       []any
	population int
}

func (d SQLiteV2Dataset) sourceProofScope(population int) *sqliteSourceProofScope {
	if d.SourceProofs == nil || d.SourceGeneration == "" {
		return nil
	}
	key := fmt.Sprintf("%d\x00%s\x00%d\x00%s\x00%#v", len(d.SourceGeneration), d.SourceGeneration, population, d.SourceSQL, d.SourceArgs)
	return &sqliteSourceProofScope{cache: d.SourceProofs, key: key, source: d.SourceSQL, args: d.SourceArgs, population: population}
}

// rows reports the whole source's row count if this generation proved it.
func (p *sqliteSourceProofScope) rows() (int64, bool) {
	if p == nil {
		return 0, false
	}
	p.cache.mu.Lock()
	defer p.cache.mu.Unlock()
	if facts := p.cache.entries[p.key]; facts != nil && facts.rows >= 0 {
		return facts.rows, true
	}
	return 0, false
}

// proven reports whether every expression is proven over the whole source,
// proving missing expressions with one statement. Only cancellation is an
// error: anything else leaves the per-execution checks in place.
func (p *sqliteSourceProofScope) proven(ctx context.Context, tx *sql.Tx, expressions []string) (bool, error) {
	if p == nil {
		return false, nil
	}
	missing := []string{}
	p.cache.mu.Lock()
	facts := p.cache.entries[p.key]
	for _, expression := range expressions {
		proven, known := false, false
		if facts != nil {
			proven, known = facts.fields[expression]
		}
		if known && !proven {
			p.cache.mu.Unlock()
			return false, nil
		}
		if !known && !containsString(missing, expression) {
			missing = append(missing, expression)
		}
	}
	p.cache.mu.Unlock()
	if len(missing) == 0 {
		return true, nil
	}
	projections := make([]string, len(missing))
	for i, expression := range missing {
		projections[i] = fmt.Sprintf("%s AS p%d", expression, i)
	}
	input := "SELECT " + strings.Join(projections, ",") + " FROM (" + p.source + ") AS r"
	stored, err := sqliteStoredProjection(ctx, tx, input, p.args)
	if err != nil || ctx.Err() != nil {
		return false, ctx.Err()
	}
	results := map[string]bool{}
	rows := int64(-1)
	if stored {
		// Most sources hold nonnegative counters: one checked SUM per field
		// proves them, as in the per-execution nonnegative plan. Fields it
		// declines (or a SUM overflow) get the signed proof.
		signed := make([]bool, len(missing))
		count, proven, err := p.prove(ctx, tx, input, signed)
		if err != nil && ctx.Err() == nil {
			for i := range signed {
				signed[i] = true
			}
			count, proven, err = p.prove(ctx, tx, input, signed)
		} else if err == nil && slices.Contains(proven, false) {
			retry := false
			for i := range proven {
				signed[i] = !proven[i]
				retry = retry || signed[i]
			}
			if retry {
				var again []bool
				if _, again, err = p.prove(ctx, tx, input, signed); err == nil {
					for i := range proven {
						proven[i] = proven[i] || again[i]
					}
				}
			}
		}
		if err != nil {
			return false, ctx.Err()
		}
		complete := count <= int64(p.population)
		if complete {
			rows = count
		}
		for i, expression := range missing {
			results[expression] = complete && proven[i]
		}
	} else {
		for _, expression := range missing {
			results[expression] = false
		}
	}
	p.cache.mu.Lock()
	defer p.cache.mu.Unlock()
	facts = p.cache.entries[p.key]
	if facts == nil {
		if p.cache.entries == nil || len(p.cache.entries) >= sqliteSourceProofEntries {
			p.cache.entries = map[string]*sqliteSourceFacts{}
		}
		facts = &sqliteSourceFacts{rows: -1, fields: map[string]bool{}}
		p.cache.entries[p.key] = facts
	}
	if rows >= 0 {
		facts.rows = rows
	}
	all := true
	for _, expression := range missing {
		facts.fields[expression] = results[expression]
		all = all && results[expression]
	}
	return all, nil
}

// prove scans the whole source (at most population+1 rows) once. For each
// expression it reports whether every value is INTEGER or NULL with an
// absolute total within 2^53-1. signed selects the proof that admits negative
// values; the default proof also requires nonnegative values.
func (p *sqliteSourceProofScope) prove(ctx context.Context, tx *sql.Tx, input string, signed []bool) (int64, []bool, error) {
	columns := []string{"COUNT(*)"}
	for i, s := range signed {
		value := fmt.Sprintf("p%d", i)
		if s {
			// TOTAL is exact while it stays within 2^53; beyond it the rounded
			// total still exceeds the bound, so the proof cannot pass by rounding.
			columns = append(columns, "COALESCE(SUM(typeof("+value+") NOT IN ('integer','null')),0)=0 AND TOTAL(abs(CAST("+value+" AS REAL)))<=9007199254740991")
			continue
		}
		// Declined values contribute a REAL zero, so an INTEGER/NULL SUM proves
		// INTEGER/NULL nonnegative storage, and its value bounds the total.
		sum := "SUM(CASE WHEN (typeof(" + value + ")='integer' AND " + value + ">=0) OR " + value + " IS NULL THEN " + value + " ELSE 0.0 END)"
		columns = append(columns, "typeof("+sum+") IN ('integer','null') AND COALESCE("+sum+",0)<=9007199254740991")
	}
	statement := "SELECT " + strings.Join(columns, ",") + fmt.Sprintf(" FROM (%s LIMIT %d)", input, p.population+1)
	values := make([]any, len(columns))
	targets := make([]any, len(columns))
	for i := range values {
		targets[i] = &values[i]
	}
	if err := tx.QueryRowContext(ctx, statement, p.args...).Scan(targets...); err != nil {
		return 0, nil, err
	}
	count, ok := values[0].(int64)
	if !ok {
		return 0, nil, fmt.Errorf("invalid source proof count")
	}
	proven := make([]bool, len(signed))
	for i := range signed {
		proven[i] = values[1+i] == int64(1)
	}
	return count, proven, nil
}
