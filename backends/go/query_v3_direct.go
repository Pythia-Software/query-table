package querytable

import (
	"context"
	"database/sql"
	"sort"
)

// TestOnlyStageUngrouped returns d with ungrouped requests sent through the
// staged executor that grouped requests use, so parity suites outside this
// module can compare both paths. It exists only for those tests.
//
// Deprecated: test-only seam; hosts must not call it. Staging copies the
// matching population and applies MaxPopulation and MaxStagingBytes.
func TestOnlyStageUngrouped(d QueryDatasetV3) QueryDatasetV3 {
	d.stageUngrouped = true
	return d
}

// sqliteDirectPopulation is the largest budget sqliteV2Dataset accepts. Its
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

// narrowSchema keeps the bindings a compiled plan reaches, the requested,
// default and tiebreak sort fields, the filtered fields, and the identity. Recompiling against it keeps materialized
// stages from carrying unrelated wide source columns.
func narrowSchema(s Schema, dependencies []string, order []OrderBy, where ...[]WhereTerm) Schema {
	names := map[string]bool{s.IDField: true}
	for _, name := range dependencies {
		names[name] = true
	}
	for _, terms := range where {
		for _, term := range terms {
			for _, predicate := range term.Predicates() {
				names[predicate.Field] = true
			}
		}
	}
	for _, term := range append(append(append([]OrderBy{}, order...), s.DefaultSort...), s.TiebreakSort...) {
		names[term.Field] = true
	}
	fields := map[string]FieldSpec{}
	for name, field := range s.Fields {
		if names[name] {
			fields[name] = field
			if field.SQLiteSortField != "" {
				fields[field.SQLiteSortField] = s.Fields[field.SQLiteSortField]
			}
		}
	}
	s.Fields = fields
	return s
}

// executeUngrouped pages, counts and reduces SourceSQL directly, with the
// same projection, envelope, values and cell errors as the staged executor.
// No population is copied and no population budget applies. Base-field
// storage is validated on the returned page and per metric bucket, as in v2.
func (d QueryDatasetV3) executeUngrouped(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions, plan SourceDependencyPlan, maxGroups int, tables *[]string) (QueryResultV3, error) {
	out := QueryResultV3{Version: 3, Now: q.Now, Rows: []map[string]any{}, Metrics: []MetricResult{}}
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
		if e == nil {
			rowsPlan, e = compileComputedRowsDialect(ctx, resultQuery, narrowSchema(d.Schema, rowsPlan.Dependencies, resultQuery.OrderBy, resultQuery.Where), o, sqlite)
		}
		if e != nil {
			return out, e
		}
		if out.Rows, err = readQueryRows(ctx, tx, rowsPlan, false, d.Dialect); err != nil {
			return out, err
		}
	}
	metricQuery := metricRequest{Version: 2, Where: resultQuery.Where, OrderBy: []OrderBy(resultQuery.OrderBy), Limit: resultQuery.Limit, Offset: resultQuery.Offset}
	metrics := make([]MetricResult, len(q.Metrics))
	batch, slots := []AggSpec{}, []int{}
	for i, spec := range q.Metrics {
		// SQLite batches share the v2 reductions; calendar metrics and every
		// PostgreSQL metric run on their own, as staged execution runs them.
		batched := sqlite && spec.DateGrouping == nil
		if batched && !metricSampled(spec) {
			batch, slots = append(batch, spec), append(slots, i)
			continue
		}
		metric, e := isolateMetric(ctx, tx, spec.ID, spec.Scope, func() (MetricResult, error) {
			if batched {
				return MetricResult{}, d.checkMetricSamples(ctx, tx, spec, metricQuery, d.Schema, o, maxGroups)
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
		v2 := sqliteV2Dataset{Schema: d.Schema, SourceSQL: d.SourceSQL, SourceArgs: d.SourceArgs, Scope: d.Scope, Dataset: d.Dataset, ComputedGroupable: d.ComputedGroupable, MaxRows: d.MaxRows, MaxGroups: d.MaxGroups, MaxPopulation: sqliteDirectPopulation, PredicateRelations: d.PredicateRelations}
		// SourcePlan validated the token and snapshot once; revisions recompile.
		batchQuery := metricQuery
		batchQuery.Profile, batchQuery.ExpectedRevisions, batchQuery.Metrics = q.Profile, q.ExpectedRevisions, batch
		r, e := v2.executeMetrics(ctx, tx, batchQuery, o, total)
		if e != nil {
			return out, e
		}
		for i, metric := range r {
			metrics[slots[i]] = metric
		}
	}
	out.Metrics = append(out.Metrics, metrics...)
	return out, ctx.Err()
}

// metricSampled reports whether a metric retains per-group samples, which
// MaxSamplesPerGroup bounds. Histograms keep only bin counters.
func metricSampled(spec AggSpec) bool {
	if spec.Distribution != nil && (spec.Distribution.Kind != "histogram" || sampledExpression(spec.Distribution.Input)) {
		return true
	}
	return sampledExpression(metricExpression(spec)) || sampledExpression(spec.ExpressionY)
}
