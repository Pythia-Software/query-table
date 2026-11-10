package sqlitetests

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A distant, result-filtered group makes the observed range too wide for the
// compact boundary plan. It supplies a reference through the per-row fallback
// for the same visible rows, without changing the calendar algorithms in tests.
func TestV3CalendarBoundariesMatchWideRangeFallback(t *testing.T) {
	for _, zone := range []struct{ name, start string }{
		{"America/Denver", "2026-03-08T05:00:00Z"},
		{"America/Denver", "2026-11-01T05:00:00Z"},
		{"Australia/Lord_Howe", "2026-10-03T12:00:00Z"},
		{"Australia/Adelaide", "2044-12-31T22:00:00Z"},
		{"Pacific/Apia", "2011-12-29T12:00:00Z"},
		// A two-hour fall-back repeat that contains a 2-hour bucket boundary.
		{"Antarctica/Troll", "2025-10-25T20:00:00Z"},
	} {
		for _, step := range []struct {
			interval string
			every    int
		}{{"hour", 1}, {"hour", 2}, {"hour", 3}, {"hour", 5}, {"day", 1}, {"day", 3}, {"week", 1}, {"week", 2}, {"month", 1}, {"month", 3}, {"year", 1}, {"year", 2}} {
			interval := step.interval
			t.Run(zone.name+"/"+zone.start+"/"+interval+"/"+strconv.Itoa(step.every), func(t *testing.T) {
				log := &statementLog{}
				db, d := hookedV3(t, log, "('null','real',1,NULL,'x')")
				f := d.Schema.Fields["at"]
				f.SQLiteDatetimeFormat = "rfc3339"
				d.Schema.Fields["at"] = f
				start, err := time.Parse(time.RFC3339, zone.start)
				if err != nil {
					t.Fatal(err)
				}
				for i := range 48 {
					// Both sides of exact boundaries and sub-millisecond values.
					at := start.Add(time.Duration(i)*time.Hour + time.Duration(i%2)*999999999*time.Nanosecond)
					if _, err := db.Exec("INSERT INTO source VALUES(?,?,?,?,?)", at.Format(time.RFC3339Nano), "real", i+1, at.Format(time.RFC3339Nano), "x"); err != nil {
						t.Fatal(err)
					}
				}
				q := groupedRequest()
				q.Grouping = &qt.GroupingDefinition{Keys: []string{"at", "k"}, KeyIntervals: map[string]qt.GroupKeyInterval{"at": {Interval: interval, Every: step.every, TimeZone: zone.name}}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}, {ID: "total", Op: "sum", Field: "n"}}}
				q.Result = qt.WireQuery{Select: []string{"at", "k", "num", "total"}, Where: []qt.WhereTerm{{Field: "k", Op: "=", Value: "real"}}, OrderBy: []qt.OrderBy{{Field: "at", Dir: "asc"}}, Limit: 100}
				log.reset(nil)
				got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if err != nil {
					t.Fatal(err)
				}
				if log.count("WITH qt_calendar_keys") != 0 {
					t.Fatal("bounded range did not use compact calendar keys")
				}
				sentinel := "2400-01-01T00:00:00.000Z"
				if interval == "year" && step.every > 1 {
					// More than the compact plan's 256 boundaries away.
					sentinel = "2900-01-01T00:00:00.000Z"
				}
				if _, err = db.Exec("INSERT INTO source VALUES('sentinel','hidden',0,?,'x')", sentinel); err != nil {
					t.Fatal(err)
				}
				log.reset(nil)
				want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if err != nil || !reflect.DeepEqual(got.Rows, want.Rows) || got.Total != want.Total || log.count("WITH qt_calendar_keys") == 0 {
					t.Fatalf("compact %#v; wide-range %#v / %v", got, want, err)
				}
			})
		}
	}
}

// A calendar key in a grouping stage gives one group per local interval,
// keyed by its start, with the same totals as the equivalent dateGrouping
// metric over the source.
func TestV3CalendarGroupKeysMatchDateGrouping(t *testing.T) {
	db, d := setupV3(t)
	d.SourceSQL = "SELECT id,k,n,qt_test_metric_probe(at) AS at,label FROM grouped"
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
		metricProbeCalls.Store(0)
		grouped, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(c, err)
		}
		if calls := metricProbeCalls.Load(); calls != 12 { // Six rows: preflight + copy.
			t.Fatalf("calendar repeated an opaque source: %d evaluations, want 12", calls)
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
