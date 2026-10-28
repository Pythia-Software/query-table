package sqlitetests

import (
	"context"
	"encoding/json"
	"fmt"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"strings"
	"testing"
	"time"
)

func TestV3FrontendParity(t *testing.T) {
	db, d := setupV3(t)
	if _, err := db.Exec(`CREATE TABLE parity(id TEXT,k TEXT,n REAL,at TEXT,label TEXT,flag INTEGER,unused TEXT)`); err != nil {
		t.Fatal(err)
	}
	d.SourceSQL = "SELECT * FROM parity"
	d.Schema.Fields["flag"] = qt.FieldSpec{Name: "flag", Kind: qt.FieldBool, Expr: "r.flag", ServerFilter: true, Sortable: true}
	d.Schema.Fields["unused"] = qt.FieldSpec{Name: "unused", Kind: qt.FieldText, Expr: "r.unused", ServerFilter: true, Sortable: true}
	type fixture struct {
		Name    string            `json:"name"`
		Rows    []map[string]any  `json:"rows"`
		Request qt.QueryRequestV3 `json:"request"`
		Result  qt.QueryResultV3  `json:"result"`
	}
	fixtures := []fixture{}
	run := func(name string, rows []map[string]any, q qt.QueryRequestV3) {
		t.Helper()
		if _, err := db.Exec("DELETE FROM parity"); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if _, err := db.Exec("INSERT INTO parity VALUES(?,?,?,?,?,?,?)", row["id"], row["k"], row["n"], row["at"], row["label"], row["flag"], strings.Repeat("unreferenced", 1000)); err != nil {
				t.Fatal(err)
			}
		}
		result, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(name, err)
		}
		fixtures = append(fixtures, fixture{name, rows, q, result})
	}
	base := []map[string]any{
		{"id": "1", "k": "a", "n": float64(1), "at": "2026-11-01T05:15:00.000Z", "label": "old", "flag": true},
		{"id": "2", "k": "a", "n": float64(3), "at": "2026-11-01T05:45:00.000Z", "label": nil, "flag": true},
		{"id": "3", "k": "a", "n": float64(3), "at": "2026-11-01T06:15:00.000Z", "label": "tie", "flag": false},
		{"id": "4", "k": "b", "n": float64(10), "at": "2026-11-01T07:15:00.000Z", "label": "b", "flag": false},
		{"id": "5", "k": "", "n": float64(2), "at": nil, "label": "empty", "flag": nil},
		{"id": "6", "k": nil, "n": float64(4), "at": nil, "label": "null", "flag": nil},
	}
	for _, keys := range [][]string{{"k"}, {"k", "flag"}, {"flag", "n"}, {"n", "k"}} {
		for _, nulls := range []string{"first", "last"} {
			for _, scope := range []string{"allMatching", "shownRows"} {
				q := groupedRequest()
				q.Grouping.Keys = keys
				q.Grouping.Representative.OrderBy = []qt.OrderBy{{Field: "n", Dir: "desc", Nulls: nulls}, {Field: "at", Dir: "asc", Nulls: "last"}}
				q.Result.Where = []qt.WhereTerm{{Field: "num", Op: ">=", Value: "1"}}
				q.Result.OrderBy = qt.OrderBys{{Field: "total", Dir: "desc"}, {Field: "num", Dir: "desc"}}
				for _, key := range keys {
					q.Result.OrderBy = append(q.Result.OrderBy, qt.OrderBy{Field: key, Dir: "asc", Nulls: "last"})
				}
				q.Result.Select = append(append([]string{}, keys...), "num", "total", "average", "median", "example", "example_id")
				q.Result.Limit = 3
				q.Result.Offset = 1
				q.Metrics = []qt.AggSpec{{ID: "group_count", Op: "count", Scope: scope}, {ID: "sum_summaries", Expression: "SUM([total])+COUNT()", Scope: scope}, {ID: "grouped", Op: "sum", Field: "total", GroupBy: []string{keys[0]}, Scope: scope}}
				run(fmt.Sprintf("groups/%v/%s/%s", keys, nulls, scope), base, q)
			}
		}
	}
	// A selected representative's NULL must not be replaced with another record.
	q := groupedRequest()
	q.Source.Where = []qt.WhereTerm{{Field: "id", Op: "!=", Value: "1"}}
	q.Grouping.Representative.OrderBy = []qt.OrderBy{{Field: "id", Dir: "asc", Nulls: "last"}}
	run("representative/null", base, q)
	cases := []struct {
		name, zone, interval, start, end string
		times                            []string
	}{
		{"ny/spring", "America/New_York", "hour", "2026-03-08", "2026-03-08", []string{"2026-03-08T06:15:00.000Z", "2026-03-08T07:15:00.000Z", "2026-03-08T08:15:00.000Z"}},
		{"ny/fall", "America/New_York", "hour", "2026-11-01", "2026-11-01", []string{"2026-11-01T05:15:00.000Z", "2026-11-01T06:15:00.000Z", "2026-11-01T07:15:00.000Z"}},
		{"lord-howe/spring", "Australia/Lord_Howe", "hour", "2026-10-04", "2026-10-04", []string{"2026-10-03T14:45:00.000Z", "2026-10-03T15:15:00.000Z", "2026-10-03T15:35:00.000Z", "2026-10-03T16:15:00.000Z"}},
		{"lord-howe/fall", "Australia/Lord_Howe", "hour", "2026-04-05", "2026-04-05", []string{"2026-04-04T14:15:00.000Z", "2026-04-04T14:45:00.000Z", "2026-04-04T15:05:00.000Z", "2026-04-04T15:45:00.000Z"}},
		{"monday/week", "Europe/Berlin", "week", "2026-12-21", "2027-01-10", []string{"2026-12-27T22:30:00.000Z", "2026-12-28T00:30:00.000Z", "2027-01-04T11:00:00.000Z"}},
		{"denver/month", "America/Denver", "month", "2026-12-01", "2027-03-31", []string{"2026-12-31T23:45:00.000Z", "2027-01-01T07:15:00.000Z", "2027-03-15T12:00:00.000Z"}},
		{"kathmandu/year", "Asia/Kathmandu", "year", "2026-01-01", "2028-12-31", []string{"2026-12-31T18:30:00.000Z", "2027-12-31T18:10:00.000Z"}},
		{"future/ny-day", "America/New_York", "day", "2044-12-30", "2045-01-02", []string{"2044-12-31T23:45:00.000Z", "2045-01-01T00:15:00.000Z"}},
		{"future/ny-week", "America/New_York", "week", "2044-12-23", "2045-01-10", []string{"2044-12-31T23:45:00.000Z", "2045-01-01T00:15:00.000Z"}},
		{"future/ny-month", "America/New_York", "month", "2044-12-01", "2045-02-01", []string{"2044-12-31T23:45:00.000Z", "2045-01-01T00:15:00.000Z"}},
		{"future/ny-year", "America/New_York", "year", "2044-01-01", "2045-12-31", []string{"2044-12-31T23:45:00.000Z", "2045-01-01T00:15:00.000Z"}},
		{"future/adelaide-hour", "Australia/Adelaide", "hour", "2045-01-01", "2045-01-01", []string{"2044-12-31T23:45:00.000Z", "2045-01-01T00:15:00.000Z"}},
		{"future/ny-spring", "America/New_York", "hour", "2044-03-13", "2044-03-13", []string{"2044-03-13T06:15:00.000Z", "2044-03-13T07:15:00.000Z"}},
		{"future/lord-howe-fall", "Australia/Lord_Howe", "hour", "2044-04-03", "2044-04-03", []string{"2044-04-02T14:15:00.000Z", "2044-04-02T15:15:00.000Z"}},
	}
	for _, c := range cases {
		for _, op := range []string{"count", "sum", "avg"} {
			for _, extra := range []bool{false, true} {
				rows := []map[string]any{}
				for i, at := range c.times {
					key := any("a")
					if i%2 != 0 {
						key = nil
					}
					rows = append(rows, map[string]any{"id": fmt.Sprint(i), "k": key, "n": float64(i) + 0.5, "at": at, "label": "row", "flag": i%2 == 0})
				}
				rows = append(rows, map[string]any{"id": "null", "k": "a", "n": nil, "at": nil, "label": nil, "flag": nil})
				groupBy := []string{"at"}
				if extra {
					groupBy = append(groupBy, "k")
				}
				field := ""
				if op != "count" {
					field = "n"
				}
				q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC).UnixMilli(), Result: qt.WireQuery{Select: []string{"id"}, Limit: 10}, Metrics: []qt.AggSpec{{ID: "calendar", Op: op, Field: field, GroupBy: groupBy, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: c.interval, TimeZone: c.zone, IncludeEmpty: true, Range: "custom", Start: c.start, End: c.end}}}}
				run(fmt.Sprintf("calendar/%s/%s/%t", c.name, op, extra), rows, q)
			}
		}
	}
	q = groupedRequest()
	q.Grouping.Summaries = append(q.Grouping.Summaries, qt.SummaryColumn{ID: "latest", Op: "max", Field: "at"})
	q.Result.Select = append(q.Result.Select, "latest")
	q.Metrics = []qt.AggSpec{{ID: "groups_by_hour", Op: "count", GroupBy: []string{"latest"}, DateGrouping: &qt.MetricDateGrouping{Field: "latest", Interval: "hour", TimeZone: "America/New_York", IncludeEmpty: true, Range: "observed"}}}
	run("calendar/grouped-result", base, q)
	q = qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Now: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC).UnixMilli(), Result: qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "at", Op: ">=", Value: "-2d"}, {Field: "at", Op: "<=", Value: "+0s"}}, Limit: 10}, Metrics: []qt.AggSpec{{ID: "window", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "day", TimeZone: "America/New_York", IncludeEmpty: true, Range: "query"}}}}
	run("calendar/query-relative", base, q)
	// Scalar set editors compile to existing predicates. NONE keeps NULL rows
	// through an explicit is_null branch, so SQL and local results agree.
	none := func(value string) qt.WhereTerm {
		return qt.WhereTerm{Any: []qt.WhereClause{{Field: "label", Op: "is_null"}, {Field: "label", Op: "!=", Value: value}}}
	}
	for name, where := range map[string][]qt.WhereTerm{
		"set/scalar-any":  {{Any: []qt.WhereClause{{Field: "label", Op: "=", Value: "old"}, {Field: "label", Op: "=", Value: "b"}}}},
		"set/scalar-none": {none("old"), none("b")},
	} {
		run(name, base, qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Result: qt.WireQuery{Select: []string{"id", "label"}, Where: where, OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}, Limit: 10}})
	}
	// An OR of AND branches as a record filter, a metric filter, a source
	// filter and a group filter. The negated literal stays null-exclusive.
	orOfAnds := qt.WhereTerm{Any: []qt.WhereClause{
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "a"}, {Field: "label", Op: "contains", Value: "o", Negated: true}}},
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "b"}, {Field: "n", Op: ">=", Value: "5"}}},
		{Field: "label", Op: "=", Value: "empty"},
	}}
	run("or-of-ands/records", base, qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile,
		Result:  qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{orOfAnds}, Limit: 10},
		Metrics: []qt.AggSpec{{ID: "population", Op: "count", GroupBy: []string{"id"}}}})
	run("or-of-ands/metric-where", base, qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile,
		Result:  qt.WireQuery{Select: []string{"id"}, Limit: 10},
		Metrics: []qt.AggSpec{{ID: "selected", Op: "count", Where: []qt.WhereTerm{orOfAnds}}, {ID: "by_key", Op: "sum", Field: "n", GroupBy: []string{"k"}, Where: []qt.WhereTerm{orOfAnds}}}})
	q = groupedRequest()
	q.Source.Where = []qt.WhereTerm{orOfAnds}
	run("or-of-ands/source", base, q)
	q = groupedRequest()
	q.Result.Where = []qt.WhereTerm{{Any: []qt.WhereClause{
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "a"}, {Field: "num", Op: ">=", Value: "2"}}},
		{All: []qt.WhereClause{{Field: "k", Op: "=", Value: "b"}, {Field: "total", Op: ">", Value: "5"}}},
	}}}
	q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}}
	run("or-of-ands/groups", base, q)
	body, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("V3_FIXTURES %s", body)
}
