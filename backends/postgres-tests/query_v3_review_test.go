package postgrestests

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestPostgresUngroupedComputedErrorCells(t *testing.T) {
	db, d := fixture(t)
	q := groupedQuery()
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

func TestPostgresGroupIdentityBatches(t *testing.T) {
	for _, groups := range []int{2000, 10000} {
		t.Run(fmt.Sprint(groups), func(t *testing.T) {
			db, d := fixture(t)
			d.SourceSQL = fmt.Sprintf(`SELECT i::text AS id,CASE i%%3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE 'key' END AS k,i::double precision AS n FROM generate_series(1,%d) AS nums(i)`, groups)
			d.MaxGroups = groups
			q := groupedQuery()
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
		})
	}
}

// Count real executions without replacing PostgreSQL's SQL evaluation. This keeps
// the performance regression independent of wall-clock timing.
type identityCountingConnector struct {
	base   driver.Driver
	record func(string, int)
}

func (c identityCountingConnector) Driver() driver.Driver { return c.base }
func (c identityCountingConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.base.Open(os.Getenv("QT_TEST_POSTGRES"))
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

func TestPostgresStagingBudgetsBeforeMaterialization(t *testing.T) {
	original, d := fixture(t)
	var created int
	db := sql.OpenDB(identityCountingConnector{base: original.Driver(), record: func(query string, _ int) {
		if strings.HasPrefix(query, "CREATE TEMP TABLE ") {
			created++
		}
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	d.SourceSQL = "SELECT CAST($1 AS TEXT) AS id,CAST($2 AS TEXT) AS k,1 AS n,NULL AS at,NULL AS label"
	q := groupedQuery()
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
	d.SourceSQL = "SELECT * FROM (SELECT '1' AS id,'a' AS k,1 AS n,NULL AS at,NULL AS label UNION ALL SELECT '2','b',2,NULL,NULL) AS source_rows"
	d.SourceArgs = nil
	d.MaxStagingBytes = 1000
	d.MaxPopulation = 1
	created = 0
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil || created != 0 {
		t.Fatalf("population budget created=%d err=%v", created, err)
	}
}

func TestPostgresFutureCalendarAndEmptySeries(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec(`DELETE FROM fixture;
INSERT INTO fixture VALUES ('1','a',1,'2044-12-31T23:45:00Z',NULL),('2','a',1,'2045-01-01T00:15:00Z',NULL)`); err != nil {
		t.Fatal(err)
	}
	q := groupedQuery()
	q.Rows, q.Grouping = false, nil
	q.Result = qt.WireQuery{Select: []string{"id"}, Limit: 10}
	q.Metrics = []qt.AggSpec{{ID: "hours", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "hour", TimeZone: "Australia/Adelaide", Range: "observed", IncludeEmpty: true}}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || len(out.Metrics) != 1 || len(out.Metrics[0].Buckets) != 1 || out.Metrics[0].Buckets[0].Keys[0] != "2044-12-31T23:30:00.000Z" || out.Metrics[0].Buckets[0].Count != 2 {
		t.Fatalf("future half-hour bucket: %#v err=%v", out, err)
	}
	for _, interval := range []string{"day", "week", "month", "year"} {
		q.Metrics[0].DateGrouping = &qt.MetricDateGrouping{Field: "at", Interval: interval, TimeZone: "America/New_York", Range: "custom", IncludeEmpty: true, Start: "2044-12-30", End: "2045-01-02"}
		if _, err = d.Execute(context.Background(), db, q, qt.PlanOptions{}); err != nil {
			t.Fatalf("future %s: %v", interval, err)
		}
	}
	if _, err = db.Exec("UPDATE fixture SET at=NULL"); err != nil {
		t.Fatal(err)
	}
	q.Metrics[0].GroupBy = []string{"at", "k"}
	q.Metrics[0].DateGrouping = &qt.MetricDateGrouping{Field: "at", Interval: "hour", TimeZone: "UTC", Range: "custom", IncludeEmpty: true, Start: "1000-01-01", End: "9999-01-01"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err = d.Execute(ctx, db, q, qt.PlanOptions{})
	if err != nil || len(out.Metrics) != 1 || len(out.Metrics[0].Buckets) != 1 || out.Metrics[0].Buckets[0].Keys[0] != nil || out.Metrics[0].Buckets[0].Count != 2 {
		t.Fatalf("null-only series: %#v err=%v", out, err)
	}
}

func TestFormulaGroupErrorsHaveDistinctIdentities(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec("DELETE FROM fixture; INSERT INTO fixture(id,n,label) VALUES('null',NULL,'null label'),('error',0,'error label'),('valid',2,'valid label')"); err != nil {
		t.Fatal(err)
	}
	q := groupedQuery()
	q.ExpectedRevisions = map[string]string{"inv": "1"}
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"@computed/inv"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}, {ID: "example", Op: "row", Field: "label"}}, Representative: &qt.RepresentativeRow{OrderBy: qt.OrderBys{{Field: "id", Dir: "asc"}}}}
	q.Result = qt.WireQuery{Select: []string{"@computed/inv", "num", "total", "example"}, Limit: 10}
	d.ComputedGroupable = map[string]bool{"inv": true}
	options := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Inverse", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1/[n]"}}, nil
	})}
	out, err := d.Execute(context.Background(), db, q, options)
	if err != nil {
		t.Fatal(err)
	}
	if out.Total != 3 || len(out.Rows) != 3 {
		t.Fatal(out)
	}
	identities := map[any]bool{}
	for _, row := range out.Rows {
		identity := row[qt.GroupIdentityField]
		if identities[identity] {
			t.Fatalf("duplicate identity: %#v", out.Rows)
		}
		identities[identity] = true
		if row["example"] != "error label" && row["num"] != float64(1) {
			t.Fatal(row)
		}
		switch row["example"] {
		case "null label":
			if row["@computed/inv"] != nil || row["total"] != nil {
				t.Fatal(row)
			}
		case "error label":
			if !reflect.DeepEqual(row["@computed/inv"], map[string]any{"computedError": "divide_by_zero"}) || !reflect.DeepEqual(row["total"], map[string]any{"computedError": "divide_by_zero"}) || !reflect.DeepEqual(row["num"], map[string]any{"computedError": "divide_by_zero"}) {
				t.Fatal(row)
			}
		case "valid label":
			if row["@computed/inv"] != float64(.5) || row["total"] != float64(2) {
				t.Fatal(row)
			}
		default:
			t.Fatal(row)
		}
	}
}

func TestPostgresShownRowsMetricRetainsErrorBindings(t *testing.T) {
	db, d := fixture(t)
	q := groupedQuery()
	q.Grouping = nil
	q.Result = qt.WireQuery{Select: []string{"id", "n"}, OrderBy: qt.OrderBys{{Field: "id", Dir: "asc"}}, Limit: 2}
	q.Metrics = []qt.AggSpec{{ID: "shown", Expression: "SUM([n])", Scope: "shownRows"}}
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil || len(out.Metrics) != 1 || out.Metrics[0].Buckets[0].Value != float64(4) {
		t.Fatalf("shown rows: %#v, %v", out, err)
	}
	// A staged formula error is still a metric error rather than a lost SQL alias.
	q.ExpectedRevisions = map[string]string{"inv": "1"}
	q.Result.Select = append(q.Result.Select, "@computed/inv")
	q.Metrics[0].Expression = "SUM([@computed/inv])"
	options := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		return qt.ComputedColumn{ID: id, Label: "Inverse", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1/([n]-1)"}}, nil
	})}
	out, err = d.Execute(context.Background(), db, q, options)
	if err != nil || out.Metrics[0].Buckets[0].Error != "divide_by_zero" {
		t.Fatalf("shown formula errors: %#v, %v", out, err)
	}
}
