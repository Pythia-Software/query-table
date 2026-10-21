package querytable

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Register scratch ownership before DDL. An interrupted CTAS may leave an
// empty relation; DROP IF EXISTS also covers DDL rolled back by a savepoint.
// A cleanup error must prevent a success result, so caller-owned transactions
// are only safe to commit after ExecuteIn returns nil.
func (d QueryDatasetV3) dropQueryTables(ctx context.Context, tx *sql.Tx, tables []string) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	schema := "temp."
	if d.Dialect == "postgres" {
		schema = "pg_temp."
	}
	var err error
	for i := len(tables) - 1; i >= 0; i-- {
		// Failed DDL or earlier per-metric cleanup can leave no TEMP table.
		// Qualify the schema so a host's persistent table is never selected.
		if _, e := tx.ExecContext(cleanup, "DROP TABLE IF EXISTS "+schema+queryIdent(tables[i])); e != nil {
			err = errors.Join(err, fmt.Errorf("drop query scratch %s: %w", tables[i], e))
		}
	}
	return err
}

// Count UTF-8 payload bytes, including error sidecars and caller-supplied
// scratch metadata, before and after materializing a temporary projection.
func (d QueryDatasetV3) stagingSizeSQL(columns []OutputColumn, extra ...string) string {
	parts := append([]string{}, extra...)
	for _, column := range columns {
		for _, alias := range []string{column.ValueAlias, column.ErrorAlias} {
			length := "length(CAST(CAST(" + queryIdent(alias) + " AS TEXT) AS BLOB))"
			if d.Dialect == "postgres" {
				length = "octet_length(CAST(" + queryIdent(alias) + " AS TEXT))"
			}
			parts = append(parts, "COALESCE("+length+",0)")
		}
	}
	return "COALESCE(SUM(" + strings.Join(parts, "+") + "),0)"
}

func (d QueryDatasetV3) checkCalendarStaging(ctx context.Context, tx *sql.Tx, source, sizeSQL string, args []any, maxPopulation int, maxBytes int64) error {
	var count, bytes int64
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*),"+sizeSQL+" FROM "+source, args...).Scan(&count, &bytes); err != nil {
		return err
	}
	if count > int64(maxPopulation) {
		return diagnostic("resource_limit", "calendar population exceeds host budget")
	}
	if bytes > maxBytes {
		return diagnostic("resource_limit", "calendar staging exceeds host byte budget")
	}
	return nil
}
