package sqlitetests

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestV3Distinct(t *testing.T) {
	db, d, o := ungroupedV3(t, 200)
	distinct := func(field, search string, limit int, where ...qt.WhereTerm) qt.QueryRequestV3 {
		q := ungroupedRequest(qt.WireQuery{Limit: 1})
		q.Rows, q.Source = false, qt.WireQuery{Where: where}
		q.Distinct = &qt.DistinctRequestV3{Field: field, Search: search, Limit: limit}
		return q
	}
	run := func(q qt.QueryRequestV3) qt.QueryResultV3 {
		t.Helper()
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		out, err := d.ExecuteIn(context.Background(), tx, q, o)
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Rows) != 0 || out.Total != 0 || out.SourceTotal != 0 || len(out.Metrics) != 0 || len(out.Schema.Fields) != 0 || out.Schema.IDField != "id" || out.Now != q.Now || out.Distinct == nil {
			t.Fatalf("distinct envelope: %#v", out)
		}
		return out
	}
	// The tenant 'one' rows cycle notes every 7 and keys every 6.
	counts := map[string]int{}
	rows, err := db.Query(`SELECT note FROM direct WHERE tenant='one' AND note IS NOT NULL AND note <> ''`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var note string
		if err = rows.Scan(&note); err != nil {
			t.Fatal(err)
		}
		counts[note]++
	}
	rows.Close()
	all := run(distinct("note", "", 500)).Distinct
	if len(all.Values) != len(counts) || all.HasMore || !all.HasNull {
		t.Fatalf("all notes: %#v %v", all, counts)
	}
	for i := 1; i < len(all.Values); i++ {
		a, b := all.Values[i-1], all.Values[i]
		if counts[a] < counts[b] || counts[a] == counts[b] && a > b {
			t.Fatalf("order %q before %q: %v", a, b, counts)
		}
	}
	if got := run(distinct("note", "RED", 1)).Distinct; len(got.Values) != 1 || !got.HasMore || !got.HasNull {
		t.Fatalf("limited search: %#v", got)
	}
	if got := run(distinct("note", "red", 10)).Distinct; strings.Join(got.Values, "|") != "Red panda|red fox" && strings.Join(got.Values, "|") != "red fox|Red panda" {
		t.Fatalf("case-insensitive search: %#v", got)
	}
	if got := run(distinct("note", "%", 10)).Distinct; len(got.Values) != 0 || !got.HasNull {
		t.Fatalf("literal search: %#v", got)
	}
	if got := run(distinct("tags", "", 10)).Distinct; !sameSet(got.Values, "red", "blue", "green") || got.Values[0] != "red" || !got.HasNull {
		t.Fatalf("array elements: %#v", got)
	}
	if got := run(distinct("k", "", 10, qt.WhereTerm{Field: "k", Op: "is_not_null"}, qt.WhereTerm{Field: "k", Op: "!=", Value: ""})).Distinct; len(got.Values) != 4 || got.HasNull {
		t.Fatalf("filtered population: %#v", got)
	}
	// SQLite text storage reads '' as NULL: never a value, always hasNull.
	if got := run(distinct("k", "", 10)).Distinct; len(got.Values) != 4 || slices.Contains(got.Values, "") || !got.HasNull {
		t.Fatalf("empty text: %#v", got)
	}
	if got := run(distinct("n", "1", 50, qt.WhereTerm{Field: "@computed/double", Op: ">", Value: "10"})).Distinct; !sameSet(got.Values, "10.0", "11.0", "12.0", "13.0") || got.HasNull {
		t.Fatalf("numbers over a computed filter: %#v", got)
	}
	// A host-filterable computed field suggests its canonical values ([n]*2).
	numbers := map[float64]bool{}
	for _, value := range run(distinct("n", "", 500)).Distinct.Values {
		n, _ := strconv.ParseFloat(value, 64)
		numbers[2*n] = true
	}
	doubled := run(distinct("@computed/double", "", 500)).Distinct
	for _, value := range doubled.Values {
		n, err := strconv.ParseFloat(value, 64)
		if err != nil || !numbers[n] {
			t.Fatalf("computed value %q: %#v", value, doubled)
		}
	}
	if len(doubled.Values) != len(numbers) || !doubled.HasNull {
		t.Fatalf("computed suggestions: %#v %v", doubled, numbers)
	}
	// Computed booleans read like stored ones.
	if got := run(distinct("@computed/big", "", 10)).Distinct; !sameSet(got.Values, run(distinct("flag", "", 10)).Distinct.Values...) {
		t.Fatalf("computed booleans: %#v", got)
	}
	// Requests are validated as a whole and decode strictly.
	bad := []qt.QueryRequestV3{distinct("note", "", 0), distinct("note", "", 501), distinct("note", strings.Repeat("x", 2001), 5), distinct("", "", 5)}
	withRows := distinct("note", "", 5)
	withRows.Rows = true
	withMetrics := distinct("note", "", 5)
	withMetrics.Metrics = []qt.AggSpec{{ID: "count", Op: "count"}}
	withGrouping := distinct("note", "", 5)
	withGrouping.Grouping = &qt.GroupingDefinition{Keys: []string{"k"}}
	var diag *qt.PlanDiagnostic
	for _, q := range append(bad, withRows, withMetrics, withGrouping) {
		if err := q.Validate(); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeInvalidQuery {
			t.Fatalf("invalid distinct accepted: %#v %v", q.Distinct, err)
		}
	}
	hidden := d
	field := hidden.Schema.Fields["note"]
	field.ServerFilter = false
	hidden.Schema.Fields = map[string]qt.FieldSpec{"note": field, "id": d.Schema.Fields["id"]}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// inv is a computed field without host filter policy.
	if _, err = d.ExecuteIn(context.Background(), tx, distinct("@computed/inv", "", 5), o); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeInvalidQuery {
		t.Fatalf("computed field without filter policy: %v", err)
	}
	for _, q := range []qt.QueryRequestV3{distinct("note", "", 5), distinct("secret", "", 5)} {
		if _, err = hidden.ExecuteIn(context.Background(), tx, q, o); !errors.As(err, &diag) || diag.Code != qt.ErrorCodeInvalidQuery {
			t.Fatalf("unfilterable field: %v", err)
		}
	}
	body := `{"version":3,"profile":"` + qt.SQLiteExpressionProfile + `","expectedRevisions":{"double":"1"},"now":1,"source":{"where":[]},"result":{"limit":1},"rows":false,"metrics":[],"hostState":{"x":1},"distinct":{"field":"note","search":"fox","limit":5}}`
	q, err := qt.DecodeQueryRequestV3([]byte(body))
	if err != nil || q.Distinct == nil || q.Distinct.Search != "fox" || q.Distinct.Limit != 5 {
		t.Fatalf("decode: %#v %v", q.Distinct, err)
	}
	if got := run(q).Distinct; strings.Join(got.Values, "|") != "red fox" {
		t.Fatalf("decoded: %#v", got)
	}
	if _, err = qt.DecodeQueryRequestV3([]byte(strings.Replace(body, `"limit":5}`, `"limit":5,"extra":1}`, 1))); err == nil {
		t.Fatal("unknown distinct property accepted")
	}
	data, _ := json.Marshal(run(q))
	if !strings.Contains(string(data), `"distinct":{"values":["red fox"],"hasMore":false,"hasNull":true}`) {
		t.Fatal(string(data))
	}
}
func sameSet(values []string, want ...string) bool {
	seen := map[string]bool{}
	for _, v := range values {
		seen[v] = true
	}
	for _, v := range want {
		if !seen[v] {
			return false
		}
	}
	return len(values) == len(want) && len(seen) == len(want)
}

func TestV3DistinctStoredMatchesGeneral(t *testing.T) {
	for _, mode := range []string{"stored", "opaque", "collation", "invalid UTF8", "NUL values", "long values", "high domain"} {
		t.Run(mode, func(t *testing.T) {
			log := &statementLog{}
			db, d := hookedV3(t, log, `('1','Red',1,NULL,'x'),('2','red',1,NULL,'x'),('3','ÉCOLE',1,NULL,'x'),('4','école',1,NULL,'x'),('5',NULL,1,NULL,'x'),('6','',1,NULL,'x')`)
			switch mode {
			case "long values":
				if _, err := db.Exec("INSERT INTO source VALUES('long',?,1,NULL,'x')", strings.Repeat("x", qt.SQLiteMaxFunctionTextBytes+1)); err != nil {
					t.Fatal(err)
				}
			case "NUL values":
				if _, err := db.Exec("INSERT INTO source VALUES('nul',?,1,NULL,'x')", "a\x00b"); err != nil {
					t.Fatal(err)
				}
			case "opaque":
				d.SourceSQL = "SELECT *,qt_test_metric_probe(k) AS probed FROM source"
				field := d.Schema.Fields["k"]
				field.Expr = "r.probed"
				d.Schema.Fields["k"] = field
			case "collation":
				field := d.Schema.Fields["k"]
				field.Expr, field.SortExpr = "r.k COLLATE NOCASE", "r.k COLLATE NOCASE"
				d.Schema.Fields["k"] = field
			case "invalid UTF8":
				if _, err := db.Exec("INSERT INTO source VALUES('invalid',CAST(X'ff' AS TEXT),1,NULL,'x')"); err != nil {
					t.Fatal(err)
				}
			case "high domain":
				// The first 64 rows look repetitive. The complete proof must
				// decline the many values after them without truncating results.
				if _, err := db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<64)
INSERT INTO source SELECT 'repeat-'||i,'repeat',1,NULL,'x' FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4097)
INSERT INTO source SELECT 'wide-'||i,'value-'||i,1,NULL,'x' FROM n`); err != nil {
					t.Fatal(err)
				}
			}
			for _, search := range []string{"", "RE", "é", "%", "\x00b", "missing"} {
				q := pharosBenchmarkRequest()
				q.Distinct = &qt.DistinctRequestV3{Field: "k", Search: search, Limit: 2}
				log.reset(nil)
				before := sqliteCalls["qt_lower"].Load()
				metricProbeCalls.Store(0)
				got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				lowerCalls, opaqueCalls := sqliteCalls["qt_lower"].Load()-before, metricProbeCalls.Load()
				if mode == "stored" && !strings.ContainsRune(search, 0) && lowerCalls != 0 {
					t.Fatalf("stored suggestions repeated row-level lowercase %d times", lowerCalls)
				}
				log.reset(declineDirect)
				metricProbeCalls.Store(0)
				want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if !reflect.DeepEqual(got, want) || (err == nil) != (wantErr == nil) || err != nil && err.Error() != wantErr.Error() || mode == "opaque" && metricProbeCalls.Load() != opaqueCalls {
					t.Fatalf("search %q: candidate %#v / %v; general %#v / %v; opaque %d/%d", search, got, err, want, wantErr, opaqueCalls, metricProbeCalls.Load())
				}
			}
		})
	}
}
