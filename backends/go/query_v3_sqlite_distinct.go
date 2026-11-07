package querytable

import (
	"context"
	"database/sql"
	"sort"
	"strings"
	"unicode/utf8"
)

// Frequent enum/text autocomplete requests can search their complete, bounded
// value counts instead of invoking qt_lower on every source row. The NULL
// bucket supplies hasNull in the same scan. No result crosses transactions.
// High-cardinality, opaque, computed, array and non-BINARY inputs keep the
// original executor. Limits bound Go memory, never truncate accepted results.
func (d QueryDatasetV3) sqliteDistinctText(ctx context.Context, tx *sql.Tx, q QueryRequestV3, o PlanOptions, b *planBuilder, value, from string) (*DistinctResultV3, error) {
	const maxValues, maxBytes = 4096, 8 << 20
	// Preserve the driver's text-function behavior for embedded NUL and the
	// scalar functions' UTF-8/size errors instead of emulating those cases.
	if strings.ContainsRune(q.Distinct.Search, 0) || !utf8.ValidString(q.Distinct.Search) {
		return nil, nil
	}
	stored, err := d.sqliteStoredFields(ctx, tx, []string{q.Distinct.Field}, q.Source.Where, o)
	if err != nil || !stored {
		return nil, err
	}
	// finish prunes stage SQL in place. Each attempt needs its own stage
	// snapshot so a later decline leaves the original executor untouched.
	finish := func(statement string) SQLPlan {
		copy := *b
		copy.stages = append([]SQLStage{}, b.stages...)
		return copy.finish(statement, "allMatching", nil)
	}
	// Reject obviously broad domains cheaply. This is only a rejection hint;
	// the complete grouped result below still has to fit the actual limits.
	probe := finish("SELECT " + value + " FROM " + from + " LIMIT 64")
	rows, err := tx.QueryContext(ctx, probe.SQL, probe.Args...)
	if err != nil {
		return nil, ctx.Err()
	}
	seen, bytes := map[string]bool{}, 0
	for rows.Next() {
		var text sql.NullString
		if err = rows.Scan(&text); err != nil {
			rows.Close()
			return nil, err
		}
		if !seen[text.String] {
			seen[text.String] = true
			bytes += len(text.String)
		}
		if len(seen) > 32 || bytes > maxBytes {
			rows.Close()
			return nil, ctx.Err()
		}
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil || closeErr != nil {
		return nil, ctx.Err()
	}
	grouped := finish("SELECT qt_value,COUNT(*) FROM (SELECT " + value + " AS qt_value FROM " + from + ") AS qt_distinct_values GROUP BY qt_value LIMIT 4097")
	// Preserve SQLite's actual grouping collation, including host collations.
	// A stored source has no sort of its own; this must be one BINARY key.
	proof, err := tx.QueryContext(ctx, "EXPLAIN "+grouped.SQL, grouped.Args...)
	if err != nil {
		return nil, ctx.Err()
	}
	binary := false
	for proof.Next() {
		values, scanErr := sqliteScanRows(proof)
		if scanErr != nil {
			proof.Close()
			return nil, scanErr
		}
		if len(values) != 8 {
			proof.Close()
			return nil, nil
		}
		if values[1] == "SorterOpen" {
			if values[5] != "k(1,B)" {
				proof.Close()
				return nil, nil
			}
			binary = true
		}
	}
	err = proof.Err()
	closeErr = proof.Close()
	if err != nil || closeErr != nil || !binary {
		return nil, ctx.Err()
	}
	rows, err = tx.QueryContext(ctx, grouped.SQL, grouped.Args...)
	if err != nil {
		return nil, ctx.Err()
	}
	defer rows.Close()
	type option struct {
		value string
		count int64
	}
	options := []option{}
	result := &DistinctResultV3{Values: []string{}}
	search := strings.ToLower(q.Distinct.Search) // Same operation as qt_lower.
	groups := 0
	bytes = 0
	for rows.Next() {
		var text sql.NullString
		var count int64
		if err = rows.Scan(&text, &count); err != nil {
			return nil, err
		}
		groups++
		bytes += len(text.String)
		if groups > maxValues || bytes > maxBytes || !utf8.ValidString(text.String) || strings.ContainsRune(text.String, 0) || search != "" && len(text.String) > SQLiteMaxFunctionTextBytes {
			return nil, ctx.Err()
		}
		if !text.Valid {
			result.HasNull = true
		} else if search == "" || strings.Contains(strings.ToLower(text.String), search) {
			options = append(options, option{text.String, count})
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(options, func(i, j int) bool {
		if options[i].count != options[j].count {
			return options[i].count > options[j].count
		}
		return options[i].value < options[j].value
	})
	if len(options) > q.Distinct.Limit {
		options, result.HasMore = options[:q.Distinct.Limit], true
	}
	for _, option := range options {
		result.Values = append(result.Values, option.value)
	}
	return result, ctx.Err()
}
