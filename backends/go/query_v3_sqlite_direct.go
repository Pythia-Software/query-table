package querytable

import (
	"context"
	"database/sql"
	"strings"
)

// Try a compact compiler-owned reduction only after SourcePlan has validated
// the full request. EXPLAIN must prove that retrying a declined domain cannot
// repeat an expensive/volatile expression. Every value and budget is still
// proved within this transaction; no declaration, sample or host cache is used.
func (d QueryDatasetV3) sqliteDirectGroups(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions, source SourceDependencyPlan, maxPop, maxGroups int, maxBytes int64, tables *[]string) (*SQLPlan, int64, error) {
	// Calendar keys are computed over the staged population.
	if d.Dialect != "sqlite" || q.Grouping == nil || q.Grouping.Representative != nil || len(q.Grouping.KeyIntervals) > 0 {
		return nil, 0, nil
	}
	for _, key := range q.Grouping.Keys {
		f := d.Schema.Fields[key]
		if f.Kind != FieldText && f.Kind != FieldEnum {
			return nil, 0, nil
		}
	}
	count := AggSpec{ID: "__qt_count__", Op: "count", GroupBy: q.Grouping.Keys}
	specs := []AggSpec{count}
	outputs := []summaryOutput{}
	for _, summary := range q.Grouping.Summaries {
		// Formulas and representatives retain the general typed executor.
		if summary.Op == "formula" || summary.Op == "row" {
			return nil, 0, nil
		}
		spec := summarySpec(summary, q.Grouping.Keys)
		specs = append(specs, spec)
		outputs = append(outputs, summaryOutput{ID: summary.ID, Expression: MetricExpression(spec)})
	}
	mq := MetricQuery{Version: 2, Where: q.Source.Where}
	combined, err := compileMetricOutputs(ctx, mq, count, d.Schema, o, true, outputs)
	if err != nil {
		return nil, 0, ctx.Err() // A combined compiler limit retains ordinary execution.
	}
	integer := sqliteIntegerReduction(ctx, mq, specs, d.Schema, o, combined,
		sqliteIntegerSourceProof{source.Columns, maxPop, maxGroups})
	if integer == nil {
		return nil, 0, nil
	}
	direct, err := sqliteStoredProjection(ctx, tx, integer.Input, integer.Args)
	if err != nil || !direct {
		return nil, 0, err
	}
	table := queryTableName()
	*tables = append(*tables, table) // Register before potentially interrupted DDL.
	for _, statement := range []string{integer.NonnegativeSQL, integer.SQL} {
		statement = strings.Replace(statement, " AS MATERIALIZED (", " AS NOT MATERIALIZED (", 1)
		valid, attemptErr := sqliteTryIntegerReduction(ctx, tx, table, statement, integer.Args)
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		if valid {
			var groups, population, bytes int64
			err = tx.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(MAX(qt_source_count),0),COALESCE(MAX(qt_source_bytes),0) FROM "+queryIdent(table)).Scan(&groups, &population, &bytes)
			if err != nil {
				return nil, 0, err
			}
			if population > int64(maxPop) {
				return nil, 0, diagnostic("resource_limit", "matching population exceeds host budget")
			}
			if bytes > maxBytes {
				return nil, 0, diagnostic("resource_limit", "source staging exceeds host byte budget")
			}
			if groups > int64(maxGroups) {
				return nil, 0, diagnostic("resource_limit", "group population exceeds host budget")
			}
			prepared, err := sqliteReplaceStage(MetricSQLPlan{SQLPlan: combined}, combined.SQLiteReductionStage, "SELECT * FROM "+queryIdent(table))
			return &prepared.SQLPlan, population, err
		}
		if _, err = tx.ExecContext(ctx, "DROP TABLE IF EXISTS temp."+queryIdent(table)); err != nil {
			return nil, 0, err
		}
		if attemptErr != nil {
			break // Statement failures also retain exact ordinary execution.
		}
	}
	return nil, 0, nil
}
