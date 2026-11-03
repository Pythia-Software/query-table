package querytable

import (
	"context"
	"database/sql"
	"sort"
)

// StageUngroupedForTesting returns d with ungrouped requests sent through the
// staged executor that grouped requests use, so parity suites outside this
// module can compare both paths. Hosts should not use it: staging copies the
// matching population and applies MaxPopulation and MaxStagingBytes.
func StageUngroupedForTesting(d QueryDatasetV3) QueryDatasetV3 {
	d.stageUngrouped = true
	return d
}

// sqliteDirectPopulation is the largest budget SQLiteV2Dataset accepts. Its
// streamed distributions keep it as a memory bound; nothing else counts to it.
const sqliteDirectPopulation = 10000000

// compilePopulation filters the authorized source by where. A plain base
// filter is read once, so PostgreSQL need not materialize the population.
func compilePopulation(ctx context.Context, where []WhereTerm, s Schema, o PlanOptions, sqlite bool) (*planBuilder, error) {
	b, err := newPlanDialect(ctx, s, o, sqlite)
	if err != nil {
		return nil, err
	}
	if err = b.filter(where); err != nil {
		return nil, err
	}
	if len(b.stages) == 2 {
		b.stages[1].Materialized = false
	}
	return b, nil
}
func (d QueryDatasetV3) countPopulation(ctx context.Context, tx *sql.Tx, where []WhereTerm, o PlanOptions) (int64, error) {
	b, err := compilePopulation(ctx, where, d.Schema, o, d.Dialect == "sqlite")
	if err != nil {
		return 0, err
	}
	p := b.finish("SELECT COUNT(*) FROM "+b.rel, "allMatching", nil)
	var total int64
	err = tx.QueryRowContext(ctx, p.SQL, p.Args...).Scan(&total)
	return total, err
}

// executeUngrouped pages, counts and reduces SourceSQL directly, with the
// same projection, envelope, values and cell errors as the staged executor.
// No population is copied and no population budget applies. Base-field
// storage is validated on the returned page and per metric bucket, as in v2.
func (d QueryDatasetV3) executeUngrouped(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions, plan SourceDependencyPlan, maxGroups int, tables *[]string) (QueryResultV3, error) {
	out := QueryResultV3{Version: 3, Now: q.Now, Rows: []map[string]any{}, Metrics: []SQLiteMetricV2{}}
	sqlite := d.Dialect == "sqlite"
	if q.ExpectedRevisions != nil {
		o.ExpectedRevisions = q.ExpectedRevisions
	}
	total, err := d.countPopulation(ctx, tx, q.Result.Where, o)
	if err != nil {
		return out, err
	}
	out.Total, out.SourceTotal = total, total
	names := []string{}
	out.Schema = ProjectedSchema{Name: d.Schema.Name, IDField: d.Schema.IDField, Fields: []ProjectedField{}}
	columns := append([]OutputColumn{}, plan.Columns...)
	sort.Slice(columns, func(i, j int) bool { return columns[i].Field < columns[j].Field })
	for _, column := range columns {
		field, ok := d.Schema.Fields[column.Field]
		if !ok {
			field = resultField(column.Field, column.Type, "", false)
		}
		names = append(names, column.Field)
		out.Schema.Fields = append(out.Schema.Fields, ProjectedField{column.Field, schemaFieldType(field.Kind)})
	}
	out.Execution = queryExecution(q, plan)
	resultQuery := q.Result
	if q.Rows {
		selected := append([]string{}, resultQuery.Select...)
		if len(selected) == 0 {
			selected = names
		}
		if !containsString(selected, d.Schema.IDField) {
			selected = append(selected, d.Schema.IDField)
		}
		resultQuery.Select = selected
		rowsPlan, e := compileComputedRowsDialect(ctx, resultQuery, d.Schema, o, sqlite)
		if e != nil {
			return out, e
		}
		if out.Rows, err = readQueryRows(ctx, tx, rowsPlan, false, d.Dialect); err != nil {
			return out, err
		}
	}
	metricQuery := MetricQuery{Version: 2, Where: resultQuery.Where, OrderBy: []OrderBy(resultQuery.OrderBy), Limit: resultQuery.Limit, Offset: resultQuery.Offset}
	metrics := make([]SQLiteMetricV2, len(q.Metrics))
	batch, slots := []AggSpec{}, []int{}
	for i, spec := range q.Metrics {
		// SQLite batches share the v2 reductions; calendar metrics and every
		// PostgreSQL metric run on their own, as staged execution runs them.
		batched := sqlite && spec.DateGrouping == nil
		if batched && !metricSampled(spec) {
			batch, slots = append(batch, spec), append(slots, i)
			continue
		}
		metric, e := isolateMetric(ctx, tx, spec.ID, spec.Scope, func() (SQLiteMetricV2, error) {
			if batched {
				return SQLiteMetricV2{}, d.checkMetricSamples(ctx, tx, spec, metricQuery, d.Schema, o, maxGroups)
			}
			return d.executeMetric(ctx, tx, spec, metricQuery, d.Schema, o, total, maxGroups, tables)
		})
		if e != nil {
			return out, e
		}
		if batched && metric.Error == "" {
			batch, slots = append(batch, spec), append(slots, i)
			continue
		}
		metrics[i] = metric
	}
	if len(batch) > 0 {
		v2 := SQLiteV2Dataset{Schema: d.Schema, SourceSQL: d.SourceSQL, SourceArgs: d.SourceArgs, Scope: d.Scope, Dataset: d.Dataset, ComputedGroupable: d.ComputedGroupable, MaxRows: d.MaxRows, MaxGroups: d.MaxGroups, MaxPopulation: sqliteDirectPopulation, PredicateRelations: d.PredicateRelations, population: &total}
		// SourcePlan validated the token and snapshot once; revisions recompile.
		batchQuery := metricQuery
		batchQuery.Profile, batchQuery.ExpectedRevisions, batchQuery.Metrics = q.Profile, q.ExpectedRevisions, batch
		r, e := v2.ExecuteV2In(ctx, tx, nil, &batchQuery, o)
		if e != nil {
			return out, e
		}
		for i, metric := range r.Metrics.Metrics {
			metrics[slots[i]] = metric
		}
	}
	out.Metrics = append(out.Metrics, metrics...)
	return out, ctx.Err()
}
func metricSampled(spec AggSpec) bool {
	return spec.Distribution != nil || sampledExpression(MetricExpression(spec)) || sampledExpression(spec.ExpressionY)
}
