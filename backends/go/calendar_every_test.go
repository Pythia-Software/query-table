package querytable

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// The fixture is shared with packages/core/test/calendarEvery.test.ts, so both
// calendars key buckets of several intervals identically.
func TestCalendarEveryFixture(t *testing.T) {
	raw, err := os.ReadFile("../../schema/fixtures/calendar-every.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name, Zone, Interval, At, Floor, Next string
			Every                                 int
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) < 20 {
		t.Fatalf("fixture has %d cases", len(fixture.Cases))
	}
	format := func(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05.000Z") }
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			loc, err := time.LoadLocation(c.Zone)
			if err != nil {
				t.Fatal(err)
			}
			at, err := time.Parse(time.RFC3339, c.At)
			if err != nil {
				t.Fatal(err)
			}
			floor, err := calendarFloorEvery(at, c.Interval, c.Every, loc)
			if err != nil || format(floor) != c.Floor {
				t.Fatalf("floor=%s err=%v, want %s", format(floor), err, c.Floor)
			}
			next, err := calendarNextEvery(at, c.Interval, c.Every, loc)
			if err != nil || format(next) != c.Next {
				t.Fatalf("next=%s err=%v, want %s", format(next), err, c.Next)
			}
			if again, err := calendarNextEvery(floor, c.Interval, c.Every, loc); err != nil || !again.Equal(next) {
				t.Fatalf("next(floor)=%s err=%v, want %s", format(again), err, c.Next)
			}
			if verified, err := calendarFloorEvery(next, c.Interval, c.Every, loc); err != nil || !verified.Equal(next) {
				t.Fatalf("floor(next)=%s err=%v, want %s", format(verified), err, c.Next)
			}
		})
	}
}

// Buckets tile the timeline around both DST changes in New York, Lord Howe
// and Troll, whose two-hour fall-back repeat contains a bucket boundary.
func TestCalendarEveryTiles(t *testing.T) {
	for _, zone := range []string{"America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "Antarctica/Troll", "UTC"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range []struct {
			interval string
			every    int
		}{{"hour", 2}, {"hour", 3}, {"hour", 8}, {"hour", 12}, {"hour", 24}, {"day", 3}, {"week", 2}, {"month", 3}} {
			for _, from := range []string{"2026-03-07", "2026-03-27", "2026-04-03", "2026-10-02", "2026-10-24", "2026-10-31"} {
				start, _ := time.Parse("2006-01-02", from)
				for at := start; at.Before(start.AddDate(0, 0, 3)); at = at.Add(30 * time.Minute) {
					floor, err := calendarFloorEvery(at, step.interval, step.every, loc)
					if err != nil {
						t.Fatal(err)
					}
					next, err := calendarNextEvery(floor, step.interval, step.every, loc)
					if err != nil || floor.After(at) || !next.After(at) {
						t.Fatalf("%s %s %d %s: [%s, %s) err=%v", zone, step.interval, step.every, at, floor, next, err)
					}
					if verified, err := calendarFloorEvery(next, step.interval, step.every, loc); err != nil || !verified.Equal(next) {
						t.Fatalf("%s %s %d: floor(%s)=%s err=%v", zone, step.interval, step.every, next, verified, err)
					}
				}
			}
		}
	}
}

func TestCalendarEveryValidation(t *testing.T) {
	base := MetricDateGrouping{Field: "at", Interval: "hour", Range: "query"}
	for _, c := range []struct {
		interval string
		every    int
		want     string
	}{
		{"hour", 0, ""}, {"hour", 1, ""}, {"month", 1000, ""}, {"hourOfDay", 1, ""},
		{"hour", -1, "1-1000"}, {"day", 1001, "1-1000"},
		{"hourOfDay", 2, "every applies to calendar intervals"}, {"dayOfWeek", 3, "every applies to calendar intervals"},
		// Hour buckets stay aligned to local days.
		{"hour", 8, ""}, {"hour", 24, ""}, {"day", 5, ""},
		{"hour", 5, "every is 1, 2, 3, 4, 6, 8, 12 or 24 hours"}, {"hour", 48, "every is 1, 2, 3, 4, 6, 8, 12 or 24 hours"},
	} {
		config := base
		config.Interval, config.Every = c.interval, c.every
		_, err := calendarLocation(config)
		if c.want == "" && err != nil || c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)) {
			t.Fatalf("%s every %d: err=%v, want %q", c.interval, c.every, err, c.want)
		}
	}
	if _, err := groupKeyLocation("datetime", "at", GroupKeyInterval{Interval: "day", Every: 1001}); err == nil {
		t.Fatal("group key every 1001 was accepted")
	}
	var diag *PlanDiagnostic
	if _, err := groupKeyLocation("datetime", "at", GroupKeyInterval{Interval: "hour", Every: 5}); !errors.As(err, &diag) || diag.Code != ErrorCodeGrouping || !strings.Contains(err.Error(), "divide a day") {
		t.Fatalf("group key every 5 hours: %v", err)
	}
	// Shared with the TypeScript engine.
	raw, err := os.ReadFile("../../schema/fixtures/calendar-every.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Rejected []struct {
			Interval string
			Every    int
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil || len(fixture.Rejected) == 0 {
		t.Fatal(err)
	}
	for _, c := range fixture.Rejected {
		config := base
		config.Interval, config.Every = c.Interval, c.Every
		if _, err := calendarLocation(config); err == nil {
			t.Fatalf("%s every %d accepted", c.Interval, c.Every)
		}
		if _, err := groupKeyLocation("datetime", "at", GroupKeyInterval{Interval: c.Interval, Every: c.Every}); !errors.As(err, &diag) || diag.Code != ErrorCodeGrouping {
			t.Fatalf("group key %s every %d: %v", c.Interval, c.Every, err)
		}
	}
}

// Go's zero Every means an omitted every; an explicit 0 on the wire is refused,
// as the schema and the TypeScript engine refuse it.
func TestCalendarEveryRejectsExplicitZero(t *testing.T) {
	stage := `{"select":[],"where":[],"orderBy":[],"limit":10,"offset":0}`
	request := func(metrics, grouping string) string {
		return `{"version":3,"profile":"p","now":0,"expectedRevisions":{},"rows":true,"source":` + stage + `,"result":` + stage + `,"metrics":[` + metrics + `]` + grouping + `}`
	}
	metric := func(every string) string {
		return `{"id":"m","op":"count","groupBy":["at"],"dateGrouping":{"field":"at","interval":"hour"` + every + `,"includeEmpty":false,"range":"query"}}`
	}
	key := func(every string) string {
		return `,"grouping":{"keys":[{"field":"at","interval":"day"` + every + `}],"summaries":[],"representative":null}`
	}
	for name, c := range map[string]struct {
		body string
		code ErrorCode
	}{
		"metric zero":   {request(metric(`,"every":0`), ""), ErrorCodeDateGrouping},
		"metric":        {request(metric(`,"every":3`), ""), ""},
		"metric absent": {request(metric(""), ""), ""},
		"key zero":      {request("", key(`,"every":0`)), ErrorCodeGrouping},
		"key":           {request("", key(`,"every":7`)), ""},
	} {
		q, err := DecodeQueryRequestV3([]byte(c.body))
		var diag *PlanDiagnostic
		if c.code == "" && err != nil || c.code != "" && (!errors.As(err, &diag) || diag.Code != c.code) {
			t.Fatalf("%s: err=%v, want %q", name, err, c.code)
		}
		if name == "key" && q.Grouping.KeyIntervals["at"].Every != 7 {
			t.Fatalf("key every: %#v", q.Grouping.KeyIntervals)
		}
	}
}

// CalendarBucket exposes the executor's calendar to Go hosts.
func TestCalendarBucket(t *testing.T) {
	at := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC) // 01:30 EST, the repeated hour
	start, next, err := CalendarBucket(at, "hour", 3, "America/New_York")
	if err != nil || !start.Equal(time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC)) || !next.Equal(time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("[%s, %s) err=%v", start, next, err)
	}
	// Every 0 and 1 are one interval.
	for _, every := range []int{0, 1} {
		start, next, err = CalendarBucket(at, "hour", every, "America/New_York")
		if err != nil || !start.Equal(time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)) || !next.Equal(time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC)) {
			t.Fatalf("every %d: [%s, %s) err=%v", every, start, next, err)
		}
	}
	start, next, err = CalendarBucket(time.Date(2026, 5, 15, 12, 0, 0, 0, time.UTC), "month", 3, "")
	if err != nil || !start.Equal(time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)) || !next.Equal(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("quarter [%s, %s) err=%v", start, next, err)
	}
	for _, bad := range []struct {
		interval, zone string
		every          int
	}{{"hourOfDay", "", 1}, {"day", "Mars/Olympus", 1}, {"day", "", 1001}, {"day", "", -1}, {"hour", "", 5}} {
		if _, _, err := CalendarBucket(at, bad.interval, bad.every, bad.zone); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
}
