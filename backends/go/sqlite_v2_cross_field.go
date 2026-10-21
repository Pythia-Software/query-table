package querytable

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

type sqliteCrossFieldReduction struct {
	key      string
	plan     SQLPlan
	aliases  map[string]string
	disabled bool
	integer  *sqliteIntegerPlan
}

// Every member has already compiled independently. Only population, scope,
// per-metric predicates and grouping determine compatibility; final formulas,
// minCount, sorting and top-N remain in the original consumer plans.
func (c *sqliteReductionCache) addCrossFields(ctx context.Context, batch MetricBatchPlan, q MetricQuery, s Schema, o PlanOptions) {
	specs := map[string]AggSpec{}
	for _, spec := range q.Metrics {
		specs[spec.ID] = spec
	}
	groups := map[string][]MetricSQLPlan{}
	order := []string{}
	for _, p := range batch.Metrics {
		spec := specs[p.ID]
		if p.reduction == nil || spec.ExpressionY != "" || sampledExpression(MetricExpression(spec)) {
			continue
		}
		key, err := json.Marshal(struct {
			Scope string
			Where []WhereTerm
			Group []string
		}{p.Scope, spec.Where, spec.GroupBy})
		if err != nil {
			continue
		}
		if _, ok := groups[string(key)]; !ok {
			order = append(order, string(key))
		}
		groups[string(key)] = append(groups[string(key)], p)
	}
	// requestOptionsDialect already validated the envelope in compileMetricsPartial.
	// Carry its revisions without invoking the host's token/snapshot callbacks again.
	if q.ExpectedRevisions != nil {
		o.ExpectedRevisions = q.ExpectedRevisions
	}
	for _, key := range order {
		members := groups[key]
		inputs := map[string]bool{}
		for _, p := range members {
			inputs[sqliteFusionKey(p)] = true
		}
		if len(inputs) < 2 {
			continue // Preserve the smaller identical-input reuse plan.
		}
		primary := specs[members[0].ID]
		extra := []summaryOutput{}
		for _, member := range members[1:] {
			extra = append(extra, summaryOutput{ID: member.ID, Expression: MetricExpression(specs[member.ID])})
		}
		primary.Sort, primary.GroupLimit, primary.MinCount = nil, 0, 0
		combined, err := compileMetricOutputs(ctx, q, primary, s, o, true, extra)
		if err != nil || len(combined.SQLiteReductionColumns) > 128 {
			continue // Combined compiler budgets never invalidate a valid member.
		}
		f := &sqliteCrossFieldReduction{key: "cross\x00" + key, plan: combined, aliases: map[string]string{}}
		integerSpecs := make([]AggSpec, 0, len(members))
		for _, member := range members {
			integerSpecs = append(integerSpecs, specs[member.ID])
		}
		f.integer = sqliteIntegerReduction(ctx, q, integerSpecs, s, o, combined)
		for name, identity := range combined.reduction.keys {
			f.aliases[identity] = name
		}
		for _, member := range members {
			c.cross[sqliteReductionKey(member)] = f
		}
	}
}

func (c *sqliteReductionCache) crossFieldPlan(ctx context.Context, tx *sql.Tx, p MetricSQLPlan, f *sqliteCrossFieldReduction) (MetricSQLPlan, error) {
	table, ok := c.tables[f.key]
	if !ok {
		table = fmt.Sprintf("_qt_reduction_%d", sqliteReductionSequence.Add(1))
		i := f.plan.SQLiteReductionStage
		statement := "CREATE TEMP TABLE " + table + " AS " + sqlStageCTEs(f.plan.Stages[:i+1]) + "\nSELECT * FROM " + f.plan.Stages[i].Name
		c.tables[f.key] = table
		if f.integer != nil {
			direct, err := sqliteStoredProjection(ctx, tx, f.integer.Input, f.integer.Args)
			if err != nil {
				return p, err
			}
			candidates := []string{f.integer.SQL}
			if direct {
				candidates = []string{f.integer.NonnegativeSQL, f.integer.SQL}
			}
			for _, candidate := range candidates {
				if direct {
					candidate = strings.Replace(candidate, " AS MATERIALIZED (", " AS NOT MATERIALIZED (", 1)
				}
				valid, err := sqliteTryIntegerReduction(ctx, tx, table, candidate, f.integer.Args)
				if valid {
					return c.crossFieldPlan(ctx, tx, p, f)
				}
				if ctx.Err() != nil {
					return p, ctx.Err()
				}
				if _, dropErr := tx.ExecContext(ctx, "DROP TABLE IF EXISTS temp."+queryIdent(table)); dropErr != nil {
					return p, dropErr
				}
				if err != nil {
					break
				} // A failed statement goes straight to the general plan.
			}
			f.integer = nil
		}
		if _, err := tx.ExecContext(ctx, statement, f.plan.Args...); err != nil {
			if ctx.Err() != nil {
				return p, err
			}
			// A statement error in one member must not fail its siblings.
			f.disabled = true
			return c.plan(ctx, tx, p)
		}
	}
	projections := make([]string, 0, len(p.SQLiteReductionColumns))
	for _, col := range p.SQLiteReductionColumns {
		alias := f.aliases[p.reduction.keys[col.Name]]
		if alias == "" {
			return p, fmt.Errorf("invalid cross-field compiler reduction envelope")
		}
		projections = append(projections, alias+" AS "+col.Name)
	}
	return sqliteReplaceStage(p, p.SQLiteReductionStage, "SELECT "+strings.Join(projections, ",")+" FROM "+table)
}

// A speculative proof is checked over the tiny reduction table before any
// original consumer sees it. Statement errors and declined domains preserve
// per-metric fallback; cancellation remains a request error.
func sqliteTryIntegerReduction(ctx context.Context, tx *sql.Tx, table, statement string, args []any) (bool, error) {
	if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE "+table+" AS "+statement, args...); err != nil {
		return false, err
	}
	var invalid int
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM "+table+" WHERE qt_integer_valid=0)").Scan(&invalid)
	return err == nil && invalid == 0, err
}
