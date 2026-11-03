package sqlitetests

import (
	"context"
	"encoding/json"
	"errors"
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
	rows, err := db.Query(`SELECT note FROM direct WHERE tenant='one' AND note IS NOT NULL`)
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
	if got := run(distinct("n", "1", 50, qt.WhereTerm{Field: "@computed/double", Op: ">", Value: "10"})).Distinct; !sameSet(got.Values, "10.0", "11.0", "12.0", "13.0") || got.HasNull {
		t.Fatalf("numbers over a computed filter: %#v", got)
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
		if err := q.Validate(); !errors.As(err, &diag) || diag.Code != "query" {
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
	for _, q := range []qt.QueryRequestV3{distinct("note", "", 5), distinct("secret", "", 5)} {
		if _, err = hidden.ExecuteIn(context.Background(), tx, q, o); !errors.As(err, &diag) || diag.Code != "query" {
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
