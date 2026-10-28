package querytable

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestCalendarFutureYearBoundaries(t *testing.T) {
	for _, zone := range []string{"America/New_York", "Australia/Adelaide"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		for _, year := range []int{2044, 2045, 2100, 2400} {
			for _, interval := range []string{"day", "week", "month", "year"} {
				for _, instant := range []time.Time{time.Date(year, 12, 31, 23, 45, 0, 0, time.UTC), time.Date(year+1, 1, 1, 0, 15, 0, 0, time.UTC)} {
					t.Run(zone+"/"+instant.Format(time.RFC3339)+"/"+interval, func(t *testing.T) {
						local := instant.In(loc)
						want := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
						switch interval {
						case "week":
							want = want.AddDate(0, 0, -((int(local.Weekday()) + 6) % 7))
						case "month":
							want = time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, loc)
						case "year":
							want = time.Date(local.Year(), 1, 1, 0, 0, 0, 0, loc)
						}
						got, err := calendarFloor(instant, interval, loc)
						if err != nil || !got.Equal(want) {
							t.Fatalf("floor=%s err=%v, want %s", got, err, want.UTC())
						}
						next, err := calendarNext(got, interval, loc)
						if err != nil || !next.After(got) {
							t.Fatalf("next=%s err=%v, floor=%s", next, err, got)
						}
					})
				}
			}
		}
	}
}

func TestCalendarFutureHalfHourZone(t *testing.T) {
	loc, err := time.LoadLocation("Australia/Adelaide")
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2044, 12, 31, 23, 30, 0, 0, time.UTC)
	for _, instant := range []time.Time{want.Add(15 * time.Minute), want.Add(45 * time.Minute)} {
		got, err := calendarFloor(instant, "hour", loc)
		if err != nil || !got.Equal(want) {
			t.Fatalf("floor(%s)=%s err=%v, want %s", instant, got, err, want)
		}
	}
	next, err := calendarNext(want, "hour", loc)
	if err != nil || !next.Equal(want.Add(time.Hour)) {
		t.Fatalf("next=%s err=%v, want %s", next, err, want.Add(time.Hour))
	}
}

func TestCalendarEmptySeriesDoesNotWalkRange(t *testing.T) {
	for _, buckets := range [][]SQLiteMetricV2Bucket{nil, {{Keys: []any{nil, "a"}, Count: 1, Value: float64(1)}}} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		result := SQLiteMetricV2{Buckets: buckets}
		config := MetricDateGrouping{Field: "at", Interval: "hour", Range: "custom", IncludeEmpty: true, Start: "1000-01-01", End: "9999-01-01"}
		spec := AggSpec{ID: "empty", Op: "count", GroupBy: []string{"at", "k"}}
		err := fillCalendarBuckets(ctx, &result, config, spec, MetricQuery{}, time.Now(), time.UTC, 2000)
		cancel()
		if err != nil || !reflect.DeepEqual(result.Buckets, buckets) {
			t.Fatalf("empty series: buckets=%#v err=%v", result.Buckets, err)
		}
		config.End = "0900-01-01"
		if err = fillCalendarBuckets(context.Background(), &result, config, spec, MetricQuery{}, time.Now(), time.UTC, 2000); err == nil {
			t.Fatal("empty series bypassed range validation")
		}
	}
}

func TestCalendarCycleSlots(t *testing.T) {
	cases := []struct {
		zone, interval, instant string
		want                    int
	}{
		{"America/New_York", "hourOfDay", "2026-03-08T06:15:00Z", 1}, // 01:15 EST
		{"America/New_York", "hourOfDay", "2026-03-08T07:15:00Z", 3}, // 03:15 EDT, after the gap
		{"America/New_York", "hourOfDay", "2026-11-01T05:15:00Z", 1}, // 01:15 EDT
		{"America/New_York", "hourOfDay", "2026-11-01T06:15:00Z", 1}, // 01:15 EST, repeated
		{"Asia/Kolkata", "hourOfDay", "2026-03-02T03:15:00Z", 8},
		{"Asia/Kolkata", "hourOfDay", "2026-03-02T03:45:00Z", 9},
		{"Asia/Kolkata", "dayOfWeek", "2026-03-01T18:45:00Z", 1}, // Monday 00:15
		{"UTC", "dayOfWeek", "2026-03-01T23:59:59Z", 7},
		{"Australia/Lord_Howe", "hourOfDay", "2026-10-03T15:35:00Z", 2}, // 02:35 after a 30-minute gap
	}
	for _, c := range cases {
		loc, err := calendarLocation(MetricDateGrouping{Field: "at", Interval: c.interval, TimeZone: c.zone, Range: "query"})
		if err != nil {
			t.Fatal(err)
		}
		instant, _ := time.Parse(time.RFC3339, c.instant)
		floor, err := calendarFloor(instant, c.interval, loc)
		if err != nil {
			t.Fatal(err)
		}
		if got := calendarSlot(floor, c.interval, loc); got != c.want || calendarSlot(instant, c.interval, loc) != c.want {
			t.Errorf("%s %s %s: slot %d, want %d", c.zone, c.interval, c.instant, got, c.want)
		}
	}
	if len(calendarSlots("hourOfDay")) != 24 || calendarSlots("hourOfDay")[23] != 23 || !reflect.DeepEqual(calendarSlots("dayOfWeek"), []float64{1, 2, 3, 4, 5, 6, 7}) {
		t.Fatal("slot lists")
	}
	if _, err := calendarLocation(MetricDateGrouping{Field: "at", Interval: "minuteOfHour", Range: "query"}); err == nil {
		t.Fatal("unknown cyclic interval accepted")
	}
}

// Every slot is filled for each observed series, without a date range.
func TestCalendarCycleFill(t *testing.T) {
	config := MetricDateGrouping{Field: "at", Interval: "dayOfWeek", IncludeEmpty: true, Range: "query"}
	spec := AggSpec{ID: "m", Op: "count", GroupBy: []string{"at", "k"}, DateGrouping: &config}
	result := SQLiteMetricV2{Buckets: []SQLiteMetricV2Bucket{{Keys: []any{float64(3), "a"}, Count: 2, Value: float64(2)}, {Keys: []any{nil, "b"}, Count: 1, Value: float64(1)}}}
	if err := fillCalendarBuckets(context.Background(), &result, config, spec, MetricQuery{}, time.Now(), time.UTC, 2000); err != nil {
		t.Fatal(err)
	}
	sortCalendarBuckets(result.Buckets, spec)
	keys := [][]any{}
	for _, bucket := range result.Buckets {
		keys = append(keys, bucket.Keys)
		if bucket.Count == 0 && bucket.Value != float64(0) {
			t.Fatalf("empty slot value %v", bucket.Value)
		}
	}
	want := [][]any{{1.0, "a"}, {2.0, "a"}, {3.0, "a"}, {4.0, "a"}, {5.0, "a"}, {6.0, "a"}, {7.0, "a"}, {nil, "b"}}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys %v", keys)
	}
	if err := fillCalendarBuckets(context.Background(), &result, config, spec, MetricQuery{}, time.Now(), time.UTC, 8); err != nil {
		t.Fatal("a complete cycle needs no new groups", err)
	}
}
