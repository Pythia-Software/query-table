package querytable

import (
	"encoding/json"
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

// Buckets tile the timeline around both DST changes in New York and Lord Howe.
func TestCalendarEveryTiles(t *testing.T) {
	for _, zone := range []string{"America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "UTC"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range []struct {
			interval string
			every    int
		}{{"hour", 2}, {"hour", 3}, {"hour", 5}, {"hour", 12}, {"day", 3}, {"week", 2}, {"month", 3}} {
			for _, from := range []string{"2026-03-07", "2026-04-03", "2026-10-02", "2026-10-31"} {
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
}
