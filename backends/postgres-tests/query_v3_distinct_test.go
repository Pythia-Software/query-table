package postgrestests

import (
	"context"
	"errors"
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
