package sqlitetests

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A calendar key in a grouping stage gives one group per local interval,
// keyed by its start, with the same totals as the equivalent dateGrouping
// metric over the source.
func TestV3CalendarGroupKeysMatchDateGrouping(t *testing.T) {
	db, d := setupV3(t)
	if !d.Capabilities().CalendarGroupKeys {
		t.Fatal("calendar group keys are not advertised")
	}
	if _, err := db.Exec(`DELETE FROM grouped; INSERT INTO grouped VALUES
		('1','a',1,'2026-03-08T06:30:00.000Z','x'),('2','a',2,'2026-03-08T07:30:00.000Z','x'),
		('3','b',3,'2026-03-08T10:30:00.000Z','x'),('4','a',4,'2026-03-09T05:59:00.000Z','x'),
		('5','b',5,'2026-03-09T06:00:00.000Z','x'),('6','a',6,NULL,'x')`); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ interval, zone string }{{"day", "America/Denver"}, {"hour", ""}, {"hour", "America/Denver"}, {"week", "Asia/Kolkata"}} {
		body := `{"version":3,"profile":"` + qt.SQLiteExpressionProfile + `","now":0,"expectedRevisions":{},"rows":true,"metrics":[],
			"source":{"select":[],"where":[],"orderBy":[],"limit":100,"offset":0},
			"result":{"select":["at","num","total"],"where":[],"orderBy":[{"field":"at","dir":"asc","nulls":"last"}],"limit":100,"offset":0},
			"grouping":{"keys":[{"field":"at","interval":"` + c.interval + `"` + map[bool]string{true: `,"timeZone":"` + c.zone + `"`, false: ""}[c.zone != ""] + `}],
			"summaries":[{"id":"num","op":"count"},{"id":"total","op":"sum","field":"n"}],"representative":null}}`
		q, err := qt.DecodeQueryRequestV3([]byte(body))
		if err != nil {
			t.Fatal(c, err)
		}
		if !reflect.DeepEqual(q.Grouping.KeyIntervals, map[string]qt.GroupKeyInterval{"at": {Interval: c.interval, TimeZone: c.zone}}) || !reflect.DeepEqual(q.Grouping.Keys, []string{"at"}) {
			t.Fatalf("%v: decoded %#v", c, q.Grouping)
		}
		encoded, err := json.Marshal(q.Grouping)
		if err != nil || !strings.Contains(string(encoded), `"keys":[{"field":"at","interval":"`+c.interval+`"`) {
			t.Fatalf("%v: encoded %s %v", c, encoded, err)
		}
		grouped, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(c, err)
		}
		metric := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Result: qt.WireQuery{Select: []string{"id"}, Limit: 10},
			Metrics: []qt.AggSpec{{ID: "m", Op: "sum", Field: "n", GroupBy: []string{"at"}, DateGrouping: &qt.MetricDateGrouping{Field: "at", Interval: c.interval, TimeZone: c.zone, Range: "query"}}}}
		calendar, err := d.Execute(context.Background(), db, metric, qt.PlanOptions{})
		if err != nil {
			t.Fatal(c, err)
		}
		got, want := [][]any{}, [][]any{}
		for _, row := range grouped.Rows {
			got = append(got, []any{row["at"], row["num"], row["total"]})
		}
		for _, bucket := range calendar.Metrics[0].Buckets {
			want = append(want, []any{bucket.Keys[0], float64(bucket.Count), bucket.Value})
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%v: groups %v, dateGrouping %v", c, got, want)
		}
		if c.zone == "America/Denver" && c.interval == "day" && got[1][0] != "2026-03-08T07:00:00.000Z" {
			t.Fatalf("local midnight key: %v", got)
		}
	}
}

func TestV3CalendarGroupKeysRejectInvalidKeys(t *testing.T) {
	db, d := setupV3(t)
	for name, key := range map[string]qt.GroupKeyInterval{
		"cycle":    {Interval: "hourOfDay"},
		"interval": {Interval: "minute"},
		"zone":     {Interval: "day", TimeZone: "Mars/Olympus"},
		"offset":   {Interval: "day", TimeZone: "+02:00"},
	} {
		q := groupedRequest()
		q.Grouping.Keys = []string{"at"}
		q.Grouping.KeyIntervals = map[string]qt.GroupKeyInterval{"at": key}
		q.Grouping.Representative, q.Grouping.Summaries = nil, []qt.SummaryColumn{{ID: "num", Op: "count"}}
		q.Result.Select, q.Result.OrderBy = []string{"at", "num"}, nil
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
			t.Errorf("%s: accepted %v", name, key)
		}
	}
	q := groupedRequest()
	q.Grouping.KeyIntervals = map[string]qt.GroupKeyInterval{"k": {Interval: "day"}}
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil || !strings.Contains(err.Error(), "datetime") {
		t.Errorf("text calendar key: %v", err)
	}
	q = groupedRequest()
	q.Grouping.KeyIntervals = map[string]qt.GroupKeyInterval{"at": {Interval: "day"}}
	if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
		t.Error("an interval for a field that is not a key was accepted")
	}
	for _, keys := range []string{`[{"field":"at","interval":"day","extra":1}]`, `[{"field":"at","interval":"day"},{"field":"at","interval":"hour"}]`, `[7]`} {
		var g qt.GroupingDefinition
		if err := json.Unmarshal([]byte(`{"keys":`+keys+`,"summaries":[],"representative":null}`), &g); err == nil {
			t.Errorf("decoded keys %s", keys)
		}
	}
}
