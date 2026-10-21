package querytable

import (
	"context"
	"database/sql"
)

// SQLite itself resolves the authorized SQL, including views, before we choose
// whether its raw projection needs materialization. Only a simple stored-column
// scan/filter/join program can be flattened. Functions, virtual tables, scalar
// subqueries, coroutines, sorting, arithmetic and aggregates retain the stored
// projection. Unknown opcodes fail closed, including on newer SQLite versions.
// EXPLAIN does not execute the source or relax any population/value guard.
func sqliteStoredProjection(ctx context.Context, tx *sql.Tx, input string, args []any) (bool, error) {
	rows, err := tx.QueryContext(ctx, "EXPLAIN "+input, args...)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, nil
	}
	defer rows.Close()
	for rows.Next() {
		values, err := sqliteScanRows(rows)
		if err != nil {
			return false, err
		}
		if len(values) != 8 {
			return false, nil
		}
		opcode, ok := values[1].(string)
		if !ok {
			return false, nil
		}
		switch opcode {
		case "Init", "Halt", "Goto", "Noop", "Transaction", "TableLock",
			"OpenRead", "Close", "Rewind", "Next", "Prev", "Last",
			"Column", "Rowid", "IdxRowid", "DeferredSeek", "SeekRowid", "NotExists",
			"SeekGE", "SeekGT", "SeekLE", "SeekLT", "IdxGE", "IdxGT", "IdxLE", "IdxLT",
			"Variable", "Null", "Integer", "Int64", "Real", "String8", "Blob",
			"Copy", "SCopy", "Move", "RealAffinity", "Affinity",
			"Eq", "Ne", "Lt", "Le", "Gt", "Ge", "IsNull", "NotNull",
			"If", "IfNot", "IfNullRow", "ZeroOrNull", "Not", "And", "Or",
			"Once", "DecrJumpZero", "ResultRow":
			// These instructions only read stored values, bind constants, compare
			// predicates or drive physical table/index cursors.
		default:
			return false, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return true, nil
}
