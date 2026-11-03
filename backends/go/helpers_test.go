package querytable

import (
	"context"
	"fmt"
	"time"
)

// These helpers reach the compilers QueryDatasetV3 executes, so plan-shape
// tests need no database.

// compileTestWhere validates q and compiles its filter as the PostgreSQL
// planner embeds it in every v3 statement.
func compileTestWhere(q WireQuery, s Schema, start int) (postgresWhere, int, error) {
	return compileTestWhereAt(q, s, start, time.Now())
}
func compileTestWhereAt(q WireQuery, s Schema, start int, now time.Time) (postgresWhere, int, error) {
	if err := q.Validate(); err != nil {
		return postgresWhere{}, start, err
	}
	return compilePostgresWhere(q.Where, s, start, now)
}

// compileTestMetrics compiles a whole metric batch, failing on any metric.
func compileTestMetrics(ctx context.Context, q metricRequest, s Schema, o PlanOptions) (metricBatchPlan, error) {
	return compileTestMetricBatch(ctx, q, s, o, false)
}
func compileTestSQLiteMetrics(ctx context.Context, q metricRequest, s Schema, o PlanOptions) (metricBatchPlan, error) {
	return compileTestMetricBatch(ctx, q, s, o, true)
}
func compileTestMetricBatch(ctx context.Context, q metricRequest, s Schema, o PlanOptions, sqlite bool) (metricBatchPlan, error) {
	result, failures, err := compileMetricsPartial(ctx, q, s, o, sqlite)
	if err != nil {
		return metricBatchPlan{}, err
	}
	for i, failure := range failures {
		if failure != nil {
			return metricBatchPlan{}, fmt.Errorf("metric %s: %w", q.Metrics[i].ID, failure)
		}
	}
	return result, nil
}

// compileTestRows compiles an ordinary PostgreSQL row page.
func compileTestRows(ctx context.Context, q WireQuery, s Schema, o PlanOptions) (SQLPlan, error) {
	return compileComputedRowsDialect(ctx, q, s, o, false)
}
func compileTestRowExpression(ctx context.Context, source string, s Schema, o PlanOptions) (SQLPlan, error) {
	return compileRowExpressionDialect(ctx, source, s, o, false)
}
func compileTestSQLiteRowExpression(ctx context.Context, source string, s Schema, o PlanOptions) (SQLPlan, error) {
	return compileRowExpressionDialect(ctx, source, s, o, true)
}
