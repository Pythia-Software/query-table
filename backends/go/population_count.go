package querytable

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
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
	// SQL and Args are the statement the executor runs to count. Args are
	// copies: pointer, slice, array and map arguments are cloned, though a
	// struct reached through them (a driver.Valuer, say) is copied shallowly.
	SQL  string
	Args []any
	// Key digests the dialect, scope, dataset, expression profile,
	// PlanOptions.Identity, SQL, the values Args bind and the revisions of the
	// computed definitions SQL reaches. Arguments are keyed by their default
	// database/sql conversion: pointers by the value they point to and
	// driver.Valuer implementations by their Value. When an argument has no
	// default conversion (a type only its driver understands), Key is unique
	// to the execution, so its count is never reused.
	//
	// Equal keys mean equal statements, not equal counts: Key does not
	// capture the data SQL reads (including temporary tables and
	// predicate-relation tables) or connection state that changes its result
	// (such as the local time zone SQLite's 'localtime' uses).
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
func (d QueryDatasetV3) newPopulationCount(where []WhereTerm, plan SQLPlan, o PlanOptions) PopulationCount {
	p := PopulationCount{Where: cloneWhereTerms(where), Now: o.Now, SQL: plan.SQL, Args: make([]any, len(plan.Args))}
	for i, arg := range plan.Args {
		p.Args[i] = cloneArgument(arg)
	}
	p.Key = populationKey(d, plan, o)
	return p
}

// populationKey digests what decides plan's result apart from data. It
// follows plan.Fingerprint, except that arguments are keyed by the values
// they bind rather than by their Go representation, which shows a pointer's
// address instead of what it points to. Relative datetime values compile to
// bound instants, so counts taken against different clocks key apart.
func populationKey(d QueryDatasetV3, plan SQLPlan, o PlanOptions) string {
	h := sha256.New()
	fmt.Fprintf(h, "population-count/2\x00%q\x00%q\x00%q\x00%q\x00%q\x00%q\x00%d", d.Dialect, d.Scope, d.Dataset, plan.Profile, o.Identity, plan.SQL, len(plan.Args))
	for _, arg := range plan.Args {
		if !writeArgumentKey(h, arg) {
			// No canonical value: never share a key.
			var nonce [16]byte
			if _, err := rand.Read(nonce[:]); err != nil {
				panic(err)
			}
			return "unique-" + hex.EncodeToString(nonce[:])
		}
	}
	for _, dependency := range plan.Dependencies {
		fmt.Fprintf(h, "\x00%q=%q", dependency, plan.ResolvedRevisions[strings.TrimPrefix(dependency, "@computed/")])
	}
	return hex.EncodeToString(h.Sum(nil))
}

// writeArgumentKey writes the value database/sql's default conversion binds
// for arg, tagged with its type, and reports whether it has one.
func writeArgumentKey(w io.Writer, arg any) bool {
	value, err := driver.DefaultParameterConverter.ConvertValue(arg)
	if err != nil {
		return false
	}
	switch value := value.(type) {
	case nil:
		fmt.Fprint(w, "\x00nil")
	case int64:
		fmt.Fprintf(w, "\x00int64:%d", value)
	case float64:
		fmt.Fprintf(w, "\x00float64:%x", math.Float64bits(value))
	case bool:
		fmt.Fprintf(w, "\x00bool:%t", value)
	case string:
		fmt.Fprintf(w, "\x00string:%q", value)
	case []byte:
		fmt.Fprintf(w, "\x00bytes:%q", value)
	case time.Time:
		fmt.Fprintf(w, "\x00time:%s", value.Format(time.RFC3339Nano))
	default:
		return false
	}
	return true
}

// cloneArgument copies the pointers, slices, arrays and maps reachable from
// arg, so a host cannot change the arguments the executor goes on to bind.
// Struct values are copied shallowly; depth bounds cyclic values.
func cloneArgument(arg any) any {
	if arg == nil {
		return nil
	}
	return cloneArgumentValue(reflect.ValueOf(arg), 32).Interface()
}

func cloneArgumentValue(v reflect.Value, depth int) reflect.Value {
	if depth == 0 {
		return v
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return v
		}
		c := reflect.New(v.Type().Elem())
		c.Elem().Set(cloneArgumentValue(v.Elem(), depth-1))
		return c
	case reflect.Interface:
		if v.IsNil() {
			return v
		}
		c := reflect.New(v.Type()).Elem()
		c.Set(cloneArgumentValue(v.Elem(), depth-1))
		return c
	case reflect.Slice:
		if v.IsNil() {
			return v
		}
		c := reflect.MakeSlice(v.Type(), v.Len(), v.Len())
		for i := 0; i < v.Len(); i++ {
			c.Index(i).Set(cloneArgumentValue(v.Index(i), depth-1))
		}
		return c
	case reflect.Array:
		c := reflect.New(v.Type()).Elem()
		for i := 0; i < v.Len(); i++ {
			c.Index(i).Set(cloneArgumentValue(v.Index(i), depth-1))
		}
		return c
	case reflect.Map:
		if v.IsNil() {
			return v
		}
		c := reflect.MakeMapWithSize(v.Type(), v.Len())
		for iter := v.MapRange(); iter.Next(); {
			c.SetMapIndex(iter.Key(), cloneArgumentValue(iter.Value(), depth-1))
		}
		return c
	}
	return v
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
