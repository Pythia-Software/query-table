package postgrestests

import (
	"context"
	"reflect"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Calendar keys in a PostgreSQL grouping stage match the dateGrouping metric,
// and group filters and ordering read the interval start.
func TestPostgresCalendarGroupKeys(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec(`DELETE FROM fixture; INSERT INTO fixture VALUES
		('1','a',1,'2026-03-08T06:30:00Z','x'),('2','a',2,'2026-03-08T07:30:00Z','x'),
		('3','b',3,'2026-03-08T10:30:00Z','x'),('4','a',4,'2026-03-09T05:59:00Z','x'),
		('5','b',5,'2026-03-09T06:00:00Z','x'),('6','a',6,NULL,'x')`); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		interval, zone string
		every          int
	}{{"day", "America/Denver", 0}, {"hour", "", 0}, {"week", "Asia/Kolkata", 0}, {"hour", "America/Denver", 3}, {"hour", "Asia/Kolkata", 5}, {"day", "America/Denver", 2}, {"month", "America/Denver", 3}} {
		q := groupedQuery()
		q.Grouping.Keys = []string{"at", "k"}
		q.Grouping.KeyIntervals = map[string]qt.GroupKeyInterval{"at": {Interval: c.interval, Every: c.every, TimeZone: c.zone}}
		q.Grouping.Summaries = []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}, {ID: "example", Op: "row", Field: "id"}}
		q.Result = qt.WireQuery{Select: []string{"at", "k", "num", "total", "example"}, OrderBy: []qt.OrderBy{{Field: "at", Dir: "asc", Nulls: "last"}, {Field: "k", Dir: "asc"}}, Limit: 100}
		grouped, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(c, err)
		}
		metric := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile, Result: qt.WireQuery{Select: []string{"id"}, Limit: 10},
			Metrics: []qt.AggSpec{{ID: "m", Op: "sum", Field: "n", GroupBy: []string{"at", "k"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: c.interval, Every: c.every, TimeZone: c.zone, Range: "query"}}}}
		calendar, err := d.Execute(context.Background(), db, metric, qt.PlanOptions{})
		if err != nil {
			t.Fatal(c, err)
		}
		got, want := [][]any{}, [][]any{}
		for _, row := range grouped.Rows {
			got = append(got, []any{row["at"], row["k"], row["num"], row["total"]})
		}
		for _, bucket := range calendar.Metrics[0].Buckets {
			want = append(want, []any{bucket.Keys[0], bucket.Keys[1], float64(bucket.Count), bucket.Value})
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%v: groups %v, dateGrouping %v", c, got, want)
		}
		if c.interval == "hour" && c.every == 3 {
			// 21:00 MST, 00:00 MST, 03:00 MDT (the spring transition), 21:00 MDT, 00:00 MDT.
			keys := []any{}
			for _, row := range got {
				keys = append(keys, row[0])
			}
			if !reflect.DeepEqual(keys, []any{"2026-03-08T04:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T09:00:00.000Z", "2026-03-09T03:00:00.000Z", "2026-03-09T06:00:00.000Z", nil}) {
				t.Fatalf("3-hour keys: %v", keys)
			}
		}
		if c.interval == "day" && c.every == 0 {
			if got[1][0] != "2026-03-08T07:00:00.000Z" || grouped.Rows[1][qt.GroupIdentityField] != `[["at","2026-03-08T07:00:00.000Z"],["k","a"]]` {
				t.Fatalf("local midnight key: %v", grouped.Rows[1])
			}
			// A group filter on the interval start.
			q.Result.Where = []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-03-08T07:00:00.000Z"}, {Field: "at", Op: "<", Value: "2026-03-09T06:00:00.000Z"}}
			filtered, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if err != nil || filtered.Total != 2 {
				t.Fatalf("group filter: %v %v", filtered.Rows, err)
			}
		}
	}
}

// Buckets of several intervals fill every bucket a query range touches,
// across the spring DST change.
func TestPostgresCalendarEveryFillsQueryRange(t *testing.T) {
	db, d := fixture(t)
	if _, err := db.Exec(`DELETE FROM fixture; INSERT INTO fixture VALUES
		('1','a',1,'2026-03-08T06:30:00Z','x'),('2','a',2,'2026-03-08T07:30:00Z','x'),
		('3','b',3,'2026-03-08T10:30:00Z','x'),('4','a',4,'2026-03-09T05:59:00Z','x'),
		('5','b',5,'2026-03-09T06:00:00Z','x'),('6','a',6,NULL,'x')`); err != nil {
		t.Fatal(err)
	}
	q := qt.QueryRequestV3{Version: 3, Profile: qt.ServerExpressionProfile,
		Result:  qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "at", Op: ">=", Value: "2026-03-08T07:00:00.000Z"}, {Field: "at", Op: "<", Value: "2026-03-09T06:00:00.000Z"}}, Limit: 10},
		Metrics: []qt.AggSpec{{ID: "m", Op: "count", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: "hour", Every: 3, TimeZone: "America/Denver", IncludeEmpty: true, Range: "query"}}}}
	result, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got := [][]any{}
	for _, bucket := range result.Metrics[0].Buckets {
		got = append(got, []any{bucket.Keys[0], bucket.Count})
	}
	// 00:00 MST, 03:00 MDT (the transition), 06:00 … 21:00 MDT.
	want := [][]any{{"2026-03-08T07:00:00.000Z", int64(1)}, {"2026-03-08T09:00:00.000Z", int64(1)}, {"2026-03-08T12:00:00.000Z", int64(0)},
		{"2026-03-08T15:00:00.000Z", int64(0)}, {"2026-03-08T18:00:00.000Z", int64(0)}, {"2026-03-08T21:00:00.000Z", int64(0)},
		{"2026-03-09T00:00:00.000Z", int64(0)}, {"2026-03-09T03:00:00.000Z", int64(1)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buckets %v, want %v", got, want)
	}
}
