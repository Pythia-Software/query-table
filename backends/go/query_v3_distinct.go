package querytable

import (
	"context"
	"database/sql"
	"strings"
)

// executeDistinct reads filter-value suggestions over the source.where
// population: matching values by count, then value, and the population's
// NULLs independent of the search. Text arrays contribute each element.
func (d QueryDatasetV3) executeDistinct(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions) (QueryResultV3, error) {
	out := QueryResultV3{Version: 3, Now: q.Now, Rows: []map[string]any{}, Metrics: []SQLiteMetricV2{}, Schema: ProjectedSchema{Name: d.Schema.Name, IDField: d.Schema.IDField, Fields: []ProjectedField{}}}
	request := *q.Distinct
	field, ok := d.Schema.Fields[request.Field]
	if !ok || !field.ServerFilter || strings.TrimSpace(field.Expr) == "" {
		return out, diagnostic("query", "distinct needs a server-filterable field")
	}
	population := q
	population.Distinct = nil
	population.Result = WireQuery{Where: q.Source.Where, Limit: 1}
	plan, err := d.SourcePlan(ctx, population, o)
	if err != nil {
		return out, err
	}
	if q.ExpectedRevisions != nil {
		o.ExpectedRevisions = q.ExpectedRevisions
	}
	sqlite := d.Dialect == "sqlite"
	b, err := compilePopulation(ctx, q.Source.Where, d.Schema, o, sqlite)
	if err != nil {
		return out, err
	}
	bound := field
	bound.Expr = b.fields[request.Field].Value
	value, from := "CAST("+bound.Expr+" AS text)", b.rel
	order := `qt_value COLLATE "C"`
	if sqlite {
		order = "qt_value COLLATE BINARY"
		if field.Kind == FieldDatetime {
			value = sqliteDateText(bound)
		}
		if field.Kind == FieldTextArray {
			value, from = "CAST(qt_distinct.value AS TEXT)", b.rel+" CROSS JOIN json_each("+sqliteArray(bound)+") AS qt_distinct"
		}
	} else {
		if field.Kind == FieldDatetime {
			value = `to_char((` + bound.Expr + `) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		}
		if field.Kind == FieldTextArray {
			value, from = "qt_distinct.qt_element", b.rel+" CROSS JOIN LATERAL unnest("+bound.Expr+") AS qt_distinct(qt_element)"
		}
	}
	condition := "qt_value IS NOT NULL"
	if request.Search != "" {
		search := b.param(request.Search, "text")
		if sqlite {
			condition += " AND instr(qt_lower(qt_value),qt_lower(" + search + "))>0"
		} else {
			condition += " AND POSITION(LOWER(" + search + ") IN LOWER(qt_value))>0"
		}
	}
	statement := "SELECT qt_value,COUNT(*) AS qt_count FROM (SELECT " + value + " AS qt_value FROM " + from + ") AS qt_values WHERE " + condition + " GROUP BY qt_value ORDER BY qt_count DESC," + order + " LIMIT " + b.param(request.Limit+1, "bigint")
	values := b.finish(statement, "allMatching", nil)
	result := &DistinctResultV3{Values: []string{}}
	rows, err := tx.QueryContext(ctx, values.SQL, values.Args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var text string
		var count int64
		if err = rows.Scan(&text, &count); err != nil {
			return out, err
		}
		result.Values = append(result.Values, text)
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	if len(result.Values) > request.Limit {
		result.Values, result.HasMore = result.Values[:request.Limit], true
	}
	b, err = compilePopulation(ctx, q.Source.Where, d.Schema, o, sqlite)
	if err != nil {
		return out, err
	}
	bound.Expr = b.fields[request.Field].Value
	null := bound.Expr + " IS NULL"
	if sqlite {
		null = sqliteNull(bound)
	} else if field.Kind == FieldTextArray {
		null = "COALESCE(cardinality(" + bound.Expr + "),0)=0"
	}
	nulls := b.finish("SELECT EXISTS(SELECT 1 FROM "+b.rel+" WHERE "+null+")", "allMatching", nil)
	if err = tx.QueryRowContext(ctx, nulls.SQL, nulls.Args...).Scan(&result.HasNull); err != nil {
		return out, err
	}
	out.Execution = queryExecution(q, plan)
	out.Distinct = result
	return out, ctx.Err()
}
