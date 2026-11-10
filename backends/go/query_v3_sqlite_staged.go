package querytable

import (
	"context"
	"database/sql"
	"strings"
)

// Keep payload decoding materialized, but inline cheap typed checks over a
// proved stored source. Ordinary host expressions retain their original
// boundaries and evaluation counts. Recompilation invokes no request token,
// snapshot or computed resolver callbacks.
func (d QueryDatasetV3) sqliteSourceProjection(ctx context.Context, tx *sql.Tx, where []WhereTerm, plan SQLPlan, o PlanOptions, maxPopulation int) (SQLPlan, error) {
	stored, err := d.sqliteStoredFields(ctx, tx, plan.Dependencies, where, o)
	if err != nil || !stored {
		return plan, err
	}
	query := WireQuery{Where: where, Limit: maxPopulation + 1}
	for _, column := range plan.Columns {
		query.Select = append(query.Select, column.Field)
	}
	o.sqliteStoredSource = true
	optimized, err := compileQuerySource(ctx, query, d.Schema, o, true)
	// SourcePlan also validates revisions that are not reached by this narrow
	// projection. Preserve that complete negotiated execution envelope.
	optimized.ResolvedRevisions = plan.ResolvedRevisions
	return optimized, err
}

func (d QueryDatasetV3) sqliteStoredFields(ctx context.Context, tx *sql.Tx, names []string, where []WhereTerm, o PlanOptions) (bool, error) {
	projections := []string{}
	names = append([]string{}, names...)
	for _, term := range where {
		for _, predicate := range term.Predicates() {
			names = append(names, predicate.Field)
		}
	}
	for _, name := range names {
		if strings.HasPrefix(name, "@computed/") {
			return false, nil
		}
		field, ok := d.Schema.Fields[name]
		if !ok {
			return false, nil
		}
		projections = append(projections, field.Expr)
		if field.ValueErrorExpr != "" {
			projections = append(projections, field.ValueErrorExpr)
		}
	}
	if len(projections) == 0 {
		return false, nil
	}
	filter, _, err := compileSQLiteWhere(where, d.Schema, sqliteOptions{Now: o.Now}, o.relations)
	if err != nil {
		return false, nil
	}
	input := "SELECT " + strings.Join(projections, ",") + " FROM (" + o.SourceSQL + ") AS r"
	if filter.SQL != "" {
		input += " WHERE " + sqliteNumberParameters(filter.SQL, len(o.SourceArgs))
	}
	args := append(append([]any{}, o.SourceArgs...), filter.Args...)
	return sqliteStoredProjection(ctx, tx, input, args)
}

// Calendar and representative requests already own a narrow typed source.
// Reduce its integer summaries without re-running decimal payload functions.
// Error sidecars are part of the proof: any error or unsupported numeric
// domain keeps the original compiled reduction and its lazy diagnostics.
func (d QueryDatasetV3) sqliteStagedGroups(ctx context.Context, tx *sql.Tx, specs []AggSpec, s Schema, o PlanOptions, combined SQLPlan, tables *[]string) (SQLPlan, error) {
	for _, name := range combined.Dependencies {
		if !s.Fields[name].typedValue {
			return combined, nil
		}
	}
	integer := sqliteIntegerReduction(ctx, metricRequest{Version: 2}, specs, s, o, combined)
	if integer == nil {
		return combined, nil
	}
	stored, err := sqliteStoredProjection(ctx, tx, integer.Input, integer.Args)
	if err != nil || !stored {
		return combined, err
	}
	// A bounded probe can reject a fractional domain early, or skip the
	// nonnegative attempt when it sees a negative. It never accepts a domain:
	// the reduction below still proves every row and every absolute total.
	numeric := []string{}
	for _, name := range combined.Dependencies {
		if field := s.Fields[name]; field.Kind == FieldNumber {
			numeric = append(numeric, field.Expr)
		}
	}
	candidates := integer.attempts()
	if len(numeric) > 0 {
		rows, err := tx.QueryContext(ctx, "SELECT "+strings.Join(numeric, ",")+" FROM ("+o.SourceSQL+") AS r LIMIT 64", o.SourceArgs...)
		if err != nil {
			return combined, ctx.Err()
		}
		eligible, negative := true, false
		for rows.Next() {
			values, scanErr := sqliteScanRows(rows)
			if scanErr != nil {
				rows.Close()
				return combined, scanErr
			}
			for _, value := range values {
				switch n := value.(type) {
				case nil:
				case int64:
					negative = negative || n < 0
				default:
					eligible = false
				}
			}
			if !eligible {
				break
			}
		}
		err = rows.Err()
		closeErr := rows.Close()
		if err != nil || closeErr != nil || !eligible {
			return combined, ctx.Err()
		}
		if negative {
			candidates = []string{integer.SQL}
		}
	}
	table := queryTableName()
	*tables = append(*tables, table)
	for _, statement := range candidates {
		statement = strings.Replace(statement, " AS MATERIALIZED (", " AS NOT MATERIALIZED (", 1)
		valid, attemptErr := sqliteTryIntegerReduction(ctx, tx, table, statement, integer.Args)
		if ctx.Err() != nil {
			return combined, ctx.Err()
		}
		if valid {
			plan, err := sqliteReplaceStage(metricSQLPlan{SQLPlan: combined}, combined.SQLiteReductionStage, "SELECT * FROM "+queryIdent(table))
			return plan.SQLPlan, err
		}
		if _, err = tx.ExecContext(ctx, "DROP TABLE IF EXISTS temp."+queryIdent(table)); err != nil {
			return combined, err
		}
		if attemptErr != nil {
			break
		}
	}
	return combined, nil
}
