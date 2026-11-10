package querytable

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// sqliteV2Dataset reduces ungrouped SQLite metric batches for QueryDatasetV3
// over its authorized SELECT. SourceArgs use numbered ?1..?N bindings.
// Scope/Dataset select the authorized definition store.
type sqliteV2Dataset struct {
	Schema            Schema
	SourceSQL         string
	SourceArgs        []any
	Scope, Dataset    string
	ComputedGroupable map[string]bool
	// Zero defaults to 10000 rows, 2000 groups and 250000 matching source rows.
	// Explicit MaxGroups may be 1..100000.
	// Limits fail explicitly; no approximate or silently truncated populations.
	MaxRows, MaxGroups, MaxPopulation int
	// PredicateRelations optionally supplies host relations for base-field
	// filter predicates in populations and metric filters.
	// Nil compiles every predicate normally. See SQLitePredicateRelations.
	PredicateRelations SQLitePredicateRelations
}

type sqliteMetricsV2Result struct {
	Metrics []MetricResult `json:"metrics"`
}

func (d sqliteV2Dataset) options(tx *sql.Tx, o PlanOptions) PlanOptions {
	o.SourceSQL = d.SourceSQL
	o.SourceArgs = append([]any{}, d.SourceArgs...)
	o.ComputedGroupable = d.ComputedGroupable
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	if o.Resolver == nil {
		o.Resolver = SQLiteComputedDefinitionResolver{Tx: tx, Scope: d.Scope, Dataset: d.Dataset}
	}
	original := o.Resolver
	cache := map[string]ComputedColumn{}
	o.Resolver = DefinitionResolverFunc(func(ctx context.Context, id string) (ComputedColumn, error) {
		if c, ok := cache[id]; ok {
			return c, nil
		}
		c, e := original.ResolveComputed(ctx, id)
		if e == nil {
			cache[id] = c
		}
		return c, e
	})
	return o
}
func (d sqliteV2Dataset) limits() (int, int, int, error) {
	rows, groups, pop := d.MaxRows, d.MaxGroups, d.MaxPopulation
	if rows == 0 {
		rows = 10000
	}
	if groups == 0 {
		groups = 2000
	}
	if pop == 0 {
		pop = 250000
	}
	if rows < 1 || rows > 10000 || groups < 1 || groups > 100000 || pop < 1 || pop > 10000000 {
		return 0, 0, 0, diagnostic(ErrorCodeResourceLimit, "invalid host execution budgets")
	}
	if e := validateSQLiteSchema(d.Schema); e != nil {
		return 0, 0, 0, e
	}
	if strings.TrimSpace(d.SourceSQL) == "" {
		return 0, 0, 0, diagnostic(ErrorCodeSourceRequired, "authorized source SELECT required")
	}
	return rows, groups, pop, nil
}

// executeMetrics reduces a batch of ungrouped SQLite metrics directly over
// SourceSQL. total is the matching population the v3 executor already counted
// in tx; no population budget applies here. Identical plans share one result
// and compatible scalar reductions share one scan.
func (d sqliteV2Dataset) executeMetrics(ctx context.Context, tx *sql.Tx, metrics metricRequest, o PlanOptions, total int64) (out []MetricResult, err error) {
	maxRows, maxGroups, maxPopulation, e := d.limits()
	if e != nil {
		return nil, e
	}
	if tx == nil {
		return nil, fmt.Errorf("nil SQLite transaction")
	}
	o = d.options(tx, o)
	o.relations = newSQLiteRelations(ctx, tx, d.PredicateRelations)
	if metrics.Limit > maxRows {
		return nil, diagnostic(ErrorCodeResourceLimit, "metric row window exceeds host budget")
	}
	batch, failures, e := compileMetricsPartial(ctx, metrics, d.Schema, o, true)
	if e != nil {
		return nil, e
	}
	// The frontend validates every revision in its handshake, including fields
	// hidden in this view. Resolve and check the complete requested envelope.
	revisions := o.ExpectedRevisions
	if metrics.ExpectedRevisions != nil {
		revisions = metrics.ExpectedRevisions
	}
	if _, _, e = d.verifyV2Revisions(ctx, o, revisions); e != nil {
		return nil, e
	}
	out = []MetricResult{}
	memo := map[string]MetricResult{}
	reductions := newSQLiteReductionCache(batch)
	reductions.addCrossFields(ctx, batch, metrics, d.Schema, o)
	defer func() {
		if cleanupErr := reductions.close(tx); cleanupErr != nil {
			out = nil
			err = errors.Join(err, cleanupErr)
		}
	}()
	direct, _, _, directErr := d.directDistributions(ctx, tx, metrics, failures, o, maxGroups, maxPopulation, total)
	if directErr != nil {
		return nil, directErr
	}
	next := 0
	for i, spec := range metrics.Metrics {
		if failures[i] != nil {
			code, message, _ := metricClauseError(ctx, failures[i])
			out = append(out, failedMetric(spec.ID, spec.Scope, code, message))
			continue
		}
		p := batch.Metrics[next]
		next++
		if m, ok := direct[i]; ok {
			out = append(out, m)
			continue
		}
		key := p.Fingerprint + "\x00" + p.Scope
		if previous, ok := memo[key]; ok {
			previous = cloneSQLiteMetric(previous)
			previous.ID = p.ID
			out = append(out, previous)
			continue
		}
		created := reductions.mark()
		m, err := isolateMetric(ctx, tx, p.ID, p.Scope, func() (MetricResult, error) {
			// The v3 executor already counted this exact authorized population
			// in this transaction. Retain the compiled COUNT consumer (including
			// minCount and result diagnostics) without reading that source again.
			if counted, ok, err := sqliteCountedMetric(p, spec, total); err != nil {
				return MetricResult{}, err
			} else if ok {
				return d.readV2Metric(ctx, tx, counted, spec, total, metrics, maxGroups)
			}
			p, err := reductions.plan(ctx, tx, p)
			if err != nil {
				return MetricResult{}, err
			}
			return d.readV2Metric(ctx, tx, p, spec, total, metrics, maxGroups)
		})
		if err != nil {
			return nil, err
		}
		if m.Error != "" {
			// The savepoint rollback dropped reductions created for this metric.
			reductions.forget(created)
		} else {
			memo[key] = m
		}
		out = append(out, m)
	}
	return out, nil
}

func sqliteCountedMetric(p metricSQLPlan, spec AggSpec, total int64) (metricSQLPlan, bool, error) {
	if p.Scope != "allMatching" || len(spec.Where) != 0 || len(spec.GroupBy) != 0 || spec.ExpressionY != "" || spec.Distribution != nil || spec.MinCount.Measure() != "" || p.reduction == nil {
		return p, false, nil
	}
	n, err := parseExpression(metricExpression(spec))
	if err != nil || strings.ToLower(n.op) != "count" || len(n.args) != 0 {
		return p, false, nil
	}
	key := expressionKey(n)
	columns := make([]string, 0, len(p.SQLiteReductionColumns))
	for _, column := range p.SQLiteReductionColumns {
		value := ""
		switch p.reduction.keys[column.Name] {
		case "count":
			value = fmt.Sprint(total)
		case "value\x00" + key:
			value = fmt.Sprintf("CAST(%d AS REAL)", total)
		case "error\x00" + key:
			value = "NULL"
		default:
			return p, false, nil
		}
		columns = append(columns, value+" AS "+column.Name)
	}
	counted, err := sqliteReplaceStage(p, p.SQLiteReductionStage, "SELECT "+strings.Join(columns, ","))
	return counted, true, err
}

// verifyV2Revisions checks the complete handshake, including unused fields.
func (d sqliteV2Dataset) verifyV2Revisions(ctx context.Context, o PlanOptions, revisions map[string]string) (map[string]string, map[string]ComputedFieldCapability, error) {
	verified := map[string]string{}
	capabilities := map[string]ComputedFieldCapability{}
	capabilityOptions := o
	capabilityOptions.ExpectedRevisions = revisions
	if len(revisions) > 64 {
		return nil, nil, diagnostic(ErrorCodeDependencyLimit, "revision envelope exceeds budget")
	}
	for id, revision := range revisions {
		if !computedID.MatchString(id) || revision == "" || len(revision) > 256 {
			return nil, nil, diagnostic(ErrorCodeDefinitionChanged, "invalid revision envelope")
		}
		c, err := o.Resolver.ResolveComputed(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		if c.ID != id || c.Revision != revision {
			return nil, nil, diagnostic(ErrorCodeDefinitionChanged, "missing or mismatched expected revision")
		}
		verified[id] = revision
		name := "@computed/" + id
		preview, err := compileSQLiteRowExpression(ctx, "["+name+"]", d.Schema, capabilityOptions)
		if err != nil {
			return nil, nil, err
		}
		capabilities[name] = d.capabilityForPlan(name, preview)
	}
	return verified, capabilities, nil
}

func sqliteScanRows(rows *sql.Rows) ([]any, error) {
	cols, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	values := make([]any, len(cols))
	targets := make([]any, len(cols))
	for i := range values {
		targets[i] = &values[i]
	}
	e = rows.Scan(targets...)
	return values, e
}
func (d sqliteV2Dataset) readV2Metric(ctx context.Context, tx *sql.Tx, p metricSQLPlan, spec AggSpec, total int64, q metricRequest, maxGroups int) (MetricResult, error) {
	processed := total
	if p.Scope == "shownRows" {
		processed -= int64(q.Offset)
		if processed < 0 {
			processed = 0
		}
		if processed > int64(q.Limit) {
			processed = int64(q.Limit)
		}
	}
	out := MetricResult{ID: p.ID, Scope: p.Scope, ProcessedRows: processed, Coverage: "exact", Buckets: []MetricBucket{}}
	rows, e := tx.QueryContext(ctx, p.SQL, p.Args...)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		return out, e
	}
	for rows.Next() {
		values, e := sqliteScanRows(rows)
		if e != nil {
			return out, e
		}
		v := map[string]any{}
		for i, k := range cols {
			v[k] = values[i]
		}
		hidden := int64(0)
		if spec.MinCount.Active() {
			var ok bool
			if hidden, ok = v["hidden_groups"].(int64); !ok {
				return out, fmt.Errorf("missing hidden group count")
			}
			out.HiddenGroups = &hidden
			if hidden > int64(maxGroups) {
				return out, diagnostic(ErrorCodeResourceLimit, "group population exceeds host budget")
			}
			// Only hidden groups (or none): the row carries no bucket.
			if v["count"] == nil {
				continue
			}
		}
		groups, ok := v["group_count"].(int64)
		if !ok {
			return out, fmt.Errorf("missing group count")
		}
		out.GroupCount = groups
		// Group budgets apply to every reduced group, including hidden ones.
		if groups+hidden > int64(maxGroups) {
			return out, diagnostic(ErrorCodeResourceLimit, "group population exceeds host budget")
		}
		for _, c := range p.Columns {
			v[c.ValueAlias] = typedQueryValue(v[c.ValueAlias], c.Type)
		}
		b := MetricBucket{Keys: []any{}, Value: v["value"], Count: v["count"].(int64), Error: sqliteErrorCode(v["error"])}
		// Calendar metrics compile a measured minimum without Min and hide
		// groups themselves, after filling empty intervals.
		if measure, ok := v["min_measure"]; ok && !spec.MinCount.Active() {
			b.minMeasure, b.minMeasureError = measure, v["min_measure_error"] != nil
		}
		for i := range spec.GroupBy {
			key := v[fmt.Sprintf("group%d", i)]
			b.Keys = append(b.Keys, key)
		}
		if spec.Distribution != nil {
			nulls := v["null_count"].(int64)
			inputErrors, ok := v["input_error_count"].(int64)
			if !ok {
				// PostgreSQL plans expose valid samples instead; invalid samples
				// are neither samples nor excluded NULLs.
				samples, _ := v["samples"].(int64)
				inputErrors = b.Count - samples - nulls
			}
			b.NullCount = &nulls
			b.InputErrorCount = &inputErrors
			if raw := v["distribution"]; raw != nil {
				var header struct{ Kind string }
				// SQLite returns JSON text; PostgreSQL drivers return jsonb bytes.
				data, ok := raw.(string)
				if bytes, isBytes := raw.([]byte); isBytes {
					data, ok = string(bytes), true
				}
				if !ok {
					return out, fmt.Errorf("distribution must be JSON text")
				}
				if e = json.Unmarshal([]byte(data), &header); e != nil {
					return out, e
				}
				switch header.Kind {
				case "box":
					var payload MetricBoxDistribution
					e = json.Unmarshal([]byte(data), &payload)
					b.Distribution = &payload
				case "histogram":
					var payload MetricHistogramDistribution
					e = json.Unmarshal([]byte(data), &payload)
					b.Distribution = &payload
				default:
					return out, fmt.Errorf("unknown distribution result")
				}
				if e != nil {
					return out, e
				}
			}
		}
		if spec.ExpressionY != "" {
			yv := v["y"]
			b.Y = &yv
			b.YError = sqliteErrorCode(v["y_error"])
		}
		out.Buckets = append(out.Buckets, b)
	}
	return out, rows.Err()
}
func (d sqliteV2Dataset) computedCapability(name, typ string) ComputedFieldCapability {
	if typ == "null" {
		typ = "text"
	}
	return ComputedFieldCapability{Type: typ, Select: true, Sort: true, Measure: true, Group: d.ComputedGroupable[strings.TrimPrefix(name, "@computed/")]}
}

func sqliteV2TypedValue(v any, typ string) any {
	if v == nil {
		return nil
	}
	if typ == "number" {
		if n, ok := v.(int64); ok {
			return float64(n)
		}
	}
	if typ == "bool" {
		if n, ok := v.(int64); ok {
			return n != 0
		}
	}
	return v
}

func sqliteErrorCode(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func (d sqliteV2Dataset) capabilityForPlan(name string, p SQLPlan) ComputedFieldCapability {
	c := d.computedCapability(name, p.Columns[0].Type)
	for _, dep := range p.Dependencies {
		if f, ok := d.Schema.Fields[dep]; ok && f.AggregateOps != nil && len(f.AggregateOps) == 0 {
			c.Measure = false
		}
	}
	return c
}

// Reuse identical plans only within the transaction after validating every plan.
// Return independent results so callers cannot mutate a sibling metric.
func cloneSQLiteMetric(m MetricResult) MetricResult {
	if m.HiddenGroups != nil {
		hidden := *m.HiddenGroups
		m.HiddenGroups = &hidden
	}
	m.Buckets = append([]MetricBucket{}, m.Buckets...)
	for i := range m.Buckets {
		b := &m.Buckets[i]
		b.Keys = append([]any{}, b.Keys...)
		if b.Y != nil {
			y := *b.Y
			b.Y = &y
		}
		if b.NullCount != nil {
			n := *b.NullCount
			b.NullCount = &n
		}
		if b.InputErrorCount != nil {
			n := *b.InputErrorCount
			b.InputErrorCount = &n
		}
		switch d := b.Distribution.(type) {
		case *MetricHistogramDistribution:
			c := *d
			c.Edges = append([]float64{}, d.Edges...)
			c.Counts = append([]int64{}, d.Counts...)
			b.Distribution = &c
		case *MetricBoxDistribution:
			c := *d
			if d.Summary != nil {
				summary := *d.Summary
				summary.Outliers = append([]float64{}, d.Summary.Outliers...)
				c.Summary = &summary
			}
			b.Distribution = &c
		}
	}
	return m
}
