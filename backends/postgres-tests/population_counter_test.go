package postgrestests

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// PostgreSQL ungrouped executions offer their population count to the host
// exactly as SQLite ones do.
func TestPostgresPopulationCounter(t *testing.T) {
	db, d, o := ungroupedV3(t, 400)
	var offered []qt.PopulationCount
	var answer func(qt.PopulationCount) (int64, bool)
	counted := d
	counted.PopulationCounter = qt.PopulationCounterFunc(func(ctx context.Context, tx *sql.Tx, p qt.PopulationCount, count func(context.Context) (int64, error)) (int64, error) {
		offered = append(offered, p)
		if answer != nil {
			if n, ok := answer(p); ok {
				return n, nil
			}
		}
		var direct int64
		if err := tx.QueryRowContext(ctx, p.SQL, p.Args...).Scan(&direct); err != nil {
			return 0, err
		}
		// Edits to the description must not reach the execution.
		for i := range p.Where {
			p.Where[i].Value = "edited"
		}
		n, err := count(ctx)
		if err == nil && n != direct {
			t.Errorf("count %d, statement %d", n, direct)
		}
		return n, err
	})
	for name, q := range ungroupedCases() {
		t.Run(name, func(t *testing.T) {
			want, err := executeV3In(db, d, q, o)
			if err != nil {
				t.Fatal(err)
			}
			offered = nil
			for range 2 {
				got, err := executeV3In(db, counted, q, o)
				if err != nil || got != want {
					t.Fatalf("with counter %s err=%v\nwithout %s", got, err, want)
				}
			}
			if len(offered) != 2 || offered[0].Key == "" || offered[0].Key != offered[1].Key || offered[0].SQL != offered[1].SQL {
				t.Fatalf("counts offered: %+v", offered)
			}
		})
	}

	q := ungroupedCases()["text sort and filter"]
	offered = nil
	var plain qt.QueryResultV3
	data, err := executeV3In(db, counted, q, o)
	if err == nil {
		err = json.Unmarshal([]byte(data), &plain)
	}
	if err != nil {
		t.Fatal(err)
	}
	key := offered[0].Key
	answer = func(p qt.PopulationCount) (int64, bool) { return plain.Total + 7, p.Key == key }
	var answered qt.QueryResultV3
	if data, err = executeV3In(db, counted, q, o); err == nil {
		err = json.Unmarshal([]byte(data), &answered)
	}
	if err != nil || answered.Total != plain.Total+7 || answered.SourceTotal != answered.Total {
		t.Fatalf("answered %d/%d, plain %d: %v", answered.Total, answered.SourceTotal, plain.Total, err)
	}
	other := counted
	other.SourceArgs = []any{"two"}
	offered = nil
	if _, err = executeV3In(db, other, q, o); err != nil || len(offered) != 1 || offered[0].Key == key {
		t.Fatalf("source arguments kept the key: %v", err)
	}
}
