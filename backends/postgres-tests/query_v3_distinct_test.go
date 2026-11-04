package postgrestests

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestPostgresDistinct(t *testing.T) {
	db, d, o := ungroupedV3(t, 200)
	distinct := func(field, search string, limit int, where ...qt.WhereTerm) qt.QueryRequestV3 {
		q := ungroupedRequest(qt.WireQuery{Limit: 1})
		q.Rows, q.Source = false, qt.WireQuery{Where: where}
		q.Distinct = &qt.DistinctRequestV3{Field: field, Search: search, Limit: limit}
		return q
	}
	run := func(q qt.QueryRequestV3) *qt.DistinctResultV3 {
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
		if len(out.Rows) != 0 || out.Total != 0 || out.SourceTotal != 0 || len(out.Metrics) != 0 || len(out.Schema.Fields) != 0 || out.Now != q.Now || out.Distinct == nil {
			t.Fatalf("distinct envelope: %#v", out)
		}
		return out.Distinct
	}
	counts := map[string]int{}
	rows, err := db.Query(`SELECT note,COUNT(*) FROM direct WHERE tenant='one' AND note IS NOT NULL GROUP BY note`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var note string
		var n int
		if err = rows.Scan(&note, &n); err != nil {
			t.Fatal(err)
		}
		counts[note] = n
	}
	rows.Close()
	all := run(distinct("note", "", 500))
	if len(all.Values) != len(counts) || all.HasMore || !all.HasNull {
		t.Fatalf("all notes: %#v %v", all, counts)
	}
	for i := 1; i < len(all.Values); i++ {
		a, b := all.Values[i-1], all.Values[i]
		if counts[a] < counts[b] || counts[a] == counts[b] && a > b {
			t.Fatalf("order %q before %q: %v", a, b, counts)
		}
	}
	if got := run(distinct("note", "RED", 1)); len(got.Values) != 1 || !got.HasMore || !got.HasNull {
		t.Fatalf("limited search: %#v", got)
	}
	if got := run(distinct("note", "red", 10)); !sameSet(got.Values, "Red panda", "red fox") {
		t.Fatalf("case-insensitive search: %#v", got)
	}
	if got := run(distinct("note", "_", 10)); len(got.Values) != 0 || !got.HasNull {
		t.Fatalf("literal search: %#v", got)
	}
	if got := run(distinct("tags", "", 10)); !sameSet(got.Values, "red", "blue", "green") || !got.HasNull {
		t.Fatalf("array elements: %#v", got)
	}
	if got := run(distinct("tags", "", 10, qt.WhereTerm{Field: "tags", Op: "is_not_null"})); got.HasNull {
		t.Fatalf("filtered arrays: %#v", got)
	}
	if got := run(distinct("n", "1", 50, qt.WhereTerm{Field: "@computed/double", Op: ">", Value: "10"})); !sameSet(got.Values, "10", "11", "12", "13") || got.HasNull {
		t.Fatalf("numbers over a computed filter: %#v", got)
	}
	if got := run(distinct("at", "2026-10-02T", 50, qt.WhereTerm{Field: "at", Op: "<", Value: "2026-10-03T00:00:00Z"})); len(got.Values) == 0 || !strings.HasSuffix(got.Values[0], ".000Z") || got.HasNull {
		t.Fatalf("datetimes: %#v", got)
	}
	if got := run(distinct("flag", "", 5)); !sameSet(got.Values, "true", "false") || !got.HasNull {
		t.Fatalf("booleans: %#v", got)
	}
	// A host-filterable computed field suggests its canonical values ([n]*2).
	doubled := []string{}
	for _, value := range run(distinct("n", "", 500)).Values {
		n, _ := strconv.ParseFloat(value, 64)
		doubled = append(doubled, strconv.FormatFloat(2*n, 'f', -1, 64))
	}
	if got := run(distinct("@computed/double", "", 500)); !sameSet(got.Values, doubled...) {
		t.Fatalf("computed values: %#v %v", got, doubled)
	}
	// A timestamp without time zone suggests its wall clock as rows show it,
	// whatever the session zone (PostgreSQL clusters often default to local).
	func() {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		// Rolled back on every path: the column's lock must not outlive a failure.
		defer tx.Rollback()
		for _, statement := range []string{`SET LOCAL TIME ZONE 'America/New_York'`, `ALTER TABLE direct ADD COLUMN local_at timestamp`,
			`UPDATE direct SET local_at = TIMESTAMP '2026-10-02 12:00'`} {
			if _, err = tx.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
		local := d
		local.Schema.Fields = map[string]qt.FieldSpec{}
		for name, f := range d.Schema.Fields {
			local.Schema.Fields[name] = f
		}
		local.Schema.Fields["local_at"] = qt.FieldSpec{Name: "local_at", Kind: qt.FieldDatetime, Expr: "r.local_at", Sortable: true, ServerFilter: true}
		out, err := local.ExecuteIn(context.Background(), tx, distinct("local_at", "", 5), o)
		if err != nil || out.Distinct == nil || !sameSet(out.Distinct.Values, "2026-10-02T12:00:00.000Z") {
			t.Fatalf("timestamp without time zone: %#v %v", out.Distinct, err)
		}
		rowsOut, err := local.ExecuteIn(context.Background(), tx, ungroupedRequest(qt.WireQuery{Select: []string{"id", "local_at"}, Limit: 1}), o)
		if err != nil || len(rowsOut.Rows) != 1 || rowsOut.Rows[0]["local_at"] != "2026-10-02T12:00:00.000Z" {
			t.Fatalf("row value: %v %v", rowsOut.Rows, err)
		}
	}()
	hidden := d
	field := hidden.Schema.Fields["note"]
	field.ServerFilter = false
	hidden.Schema.Fields = map[string]qt.FieldSpec{"note": field, "id": d.Schema.Fields["id"]}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var diag *qt.PlanDiagnostic
	for _, q := range []qt.QueryRequestV3{distinct("note", "", 5), distinct("secret", "", 5)} {
		if _, err = hidden.ExecuteIn(context.Background(), tx, q, o); !errors.As(err, &diag) || diag.Code != "query" {
			t.Fatalf("unfilterable field: %v", err)
		}
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
