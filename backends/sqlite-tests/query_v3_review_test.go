package sqlitetests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestV3UngroupedComputedErrorCells(t *testing.T) {
	db, d := setupV3(t)
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id", "@computed/inv"}, OrderBy: qt.OrderBys{{Field: "id", Dir: "asc"}}, Limit: 10}
	q.ExpectedRevisions = map[string]string{"inv": "1"}
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Inverse", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1/([n]-1)"}}, nil
	})}
	out, err := d.Execute(context.Background(), db, q, o)
	if err != nil {
		t.Fatal(err)
	}
	if out.Total != 6 || out.SourceTotal != 6 || len(out.Rows) != 6 {
		t.Fatal(out)
	}
	for i, want := range []any{map[string]any{"computedError": "divide_by_zero"}, float64(.5), float64(.5), float64(1) / 9, float64(1), float64(1) / 3} {
		if !reflect.DeepEqual(out.Rows[i]["@computed/inv"], want) {
			t.Fatalf("row %d: got %#v want %#v", i, out.Rows[i], want)
		}
	}
	// A typed base-field failure must still reject the complete request.
	field := d.Schema.Fields["n"]
	field.ValueErrorExpr = "CASE WHEN r.n=1 THEN 'invalid_number' ELSE NULL END"
	d.Schema.Fields["n"] = field
	q.Result.Select = append(q.Result.Select, "n")
	var diag *qt.PlanDiagnostic
	if _, err = d.Execute(context.Background(), db, q, o); !errors.As(err, &diag) || diag.Code != "invalid_source_value" {
		t.Fatalf("base-field failure: %v", err)
	}
}

// Count real executions without replacing SQLite's SQL evaluation. This keeps
// the performance regression independent of wall-clock timing.
type identityCountingConnector struct {
	base   driver.Driver
	record func(string, int)
}

func (c identityCountingConnector) Driver() driver.Driver { return c.base }
func (c identityCountingConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(":memory:")
	if err != nil {
		return nil, err
	}
	return identityCountingConn{Conn: conn, QueryerContext: conn.(driver.QueryerContext), ConnBeginTx: conn.(driver.ConnBeginTx), record: c.record}, nil
}

type identityCountingConn struct {
	driver.Conn
	driver.QueryerContext
	driver.ConnBeginTx
	record func(string, int)
}

func (c identityCountingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.record(query, len(args))
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
}

func TestV3GroupIdentityBatches(t *testing.T) {
	for _, groups := range []int{2000, 10000} {
		t.Run(fmt.Sprint(groups), func(t *testing.T) {
			original, d := setupV3(t)
			var mu sync.Mutex
			var updates []int
			db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, args int) {
				if strings.Contains(query, " SET identity=") {
					mu.Lock()
					defer mu.Unlock()
					updates = append(updates, args)
				}
			}})
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { db.Close() })
			d.SourceSQL = fmt.Sprintf(`WITH RECURSIVE nums(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM nums WHERE i<%d)
SELECT CAST(i AS TEXT) AS id,CASE i%%3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE 'key' END AS k,i AS n,NULL AS at,NULL AS label FROM nums`, groups)
			d.MaxGroups = groups
			q := groupedRequest()
			q.Grouping = &qt.GroupingDefinition{Keys: []string{"n", "k"}}
			q.Result = qt.WireQuery{Select: []string{"k", "n"}, OrderBy: qt.OrderBys{{Field: "n", Dir: "asc"}}, Limit: groups}
			out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if out.Total != int64(groups) || len(out.Rows) != groups {
				t.Fatalf("got total=%d rows=%d, want %d", out.Total, len(out.Rows), groups)
			}
			for i, row := range out.Rows {
				n := i + 1
				var key any
				switch n % 3 {
				case 1:
					key = ""
				case 2:
					key = "key"
				}
				identity, _ := json.Marshal([][]any{{"k", key}, {"n", n}})
				if row["n"] != float64(n) || row["k"] != key || row[qt.GroupIdentityField] != string(identity) {
					t.Fatalf("group %d: got %#v, want identity %s", n, row, identity)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			// At most five updates at the default budget, 25 at the maximum.
			if len(updates) == 0 || len(updates) > (groups+399)/400 {
				t.Fatalf("%d groups needed %d identity updates", groups, len(updates))
			}
			for _, count := range updates {
				if count > 999 {
					t.Fatalf("identity update exceeds SQLite's portable parameter limit: %d", count)
				}
			}
			t.Logf("%d groups: %d identity updates", groups, len(updates))
		})
	}
}

func TestV3StagingBudgetsBeforeMaterialization(t *testing.T) {
	original, d := setupV3(t)
	var created int
	db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, _ int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") {
			created++
		}
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = "SELECT CAST(?1 AS TEXT) AS id,CAST(?2 AS TEXT) AS k,1 AS n,NULL AS at,NULL AS label"
	q := groupedRequest()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id", "k"}, Limit: 10}
	for _, value := range []string{strings.Repeat("x", 64), strings.Repeat("😀", 16)} {
		d.SourceArgs = []any{"1", value}
		d.MaxStagingBytes = 32
		created = 0
		var diag *qt.PlanDiagnostic
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &diag) || diag.Code != "resource_limit" {
			t.Fatalf("oversized source: %v", err)
		}
		if created != 0 {
			t.Fatalf("oversized source materialized %d temp tables", created)
		}
		d.MaxStagingBytes = int64(len(value) + 1)
		out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil || len(out.Rows) != 1 || out.Rows[0]["k"] != value {
			t.Fatalf("exact byte boundary: %#v err=%v", out, err)
		}
	}
	d.SourceSQL = "SELECT * FROM (SELECT '1' AS id,'a' AS k,1 AS n,NULL AS at,NULL AS label UNION ALL SELECT '2','b',2,NULL,NULL)"
	d.SourceArgs = nil
	d.MaxStagingBytes = 1000
	d.MaxPopulation = 1
	created = 0
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil || created != 0 {
		t.Fatalf("population budget created=%d err=%v", created, err)
	}
}
