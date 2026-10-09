# Metric output formatting

> Design reference preserved from the approved prototype. Production APIs and current integration limits are documented in [Metrics](metrics.md) and [Backend metrics](backend-metrics.md).

Status: design and working prototype. This adds optional frontend presentation; no server computation or public API changes are included.

The metric editor's Display section offers **Number, Percent, Duration, Date, Time, Date & time**. Choosing a temporal type reveals source units/encoding, label presets, an optional custom format string and timezone where relevant. A live raw-result → formatted-label example makes the selected interpretation explicit. Scatterplots configure X and Y independently through Format measure; settings persist with the metric. The separate Labels section continues to edit titles/axis captions, while output formatting edits the actual values and ticks.

| Type | Source contract | Default | Other options |
| --- | --- | --- | --- |
| Duration | Finite numeric amount; explicit milliseconds, seconds, minutes, hours or days | Compact, at most two nonzero components; `84000` seconds → `23h20m`, `84000` milliseconds → `1m24s` | Long `23 hours, 20 minutes`; clock `23:20:00`; custom tokens |
| Date | ISO calendar date or offset-qualified timestamp; alternatively numeric Unix seconds/milliseconds | `Oct 8, 2026`, UTC for instants | `2026-10-08`; custom tokens and explicit timezone |
| Time | ISO clock time or offset-qualified timestamp; Unix seconds/milliseconds or numeric seconds/milliseconds since midnight | 24-hour `14:30:00` | 12-hour `02:30:00 PM`; custom tokens and timezone for instants |
| Date & time | Offset-qualified ISO timestamp or explicit Unix units; ISO date is midnight of that calendar date | `Oct 8, 2026, 14:30:00 UTC` | ISO-style `2026-10-08 14:30:00 +00:00`; custom tokens |

Numeric units are never guessed by magnitude. The initial UI defaults duration to milliseconds, matching the existing `duration_ms` renderer; numeric timestamps require choosing Unix seconds or milliseconds rather than pretending to be ISO text. Full numeric strings such as `"84000"` may be decoded for presentation under an explicit numeric unit; commas, boolean coercions, Infinity and partial numeric strings are rejected. The server should still provide typed numeric values for reliable sorting. Frontend formatting cannot repair a server sorting numeric text lexically.

Duration is an elapsed quantity. It never passes through `Date`, a timezone, DST or month/year calendars. Preserve a negative sign, show zero explicitly, and retain millisecond/subsecond precision for small values. Compact labels round before carrying boundaries and display up to two nonzero components: 59.9999 seconds becomes `1m`, never `60s`/`1m60s`. Clock style uses unbounded total hours (`90000` seconds → `25:00:00`), not a clock modulo 24. A day is exactly 86,400 elapsed seconds. The prototype bounds normalized milliseconds to safe numeric precision; more precision requires a typed decimal/integer protocol, not formatting tricks. Compact omission/rounding is presentation only; inspect retains the original exact result. Existing `renderers.ts` already has a simple millisecond duration renderer; extract/generalize first-party helpers in implementation, with fixtures for carry, signed values and subsecond output rather than changing that renderer's behavior incidentally.

Date/time parsing is strict: ISO date `YYYY-MM-DD`; clock `HH:mm[:ss[.SSS]]`; timestamps require `T`, seconds and an explicit `Z`/numeric timezone offset. Reject impossible calendar dates (including February 30), invalid clocks, naive datetime strings, locale-ambiguous text and out-of-range timestamps. The prototype's calendar output supports years 0001–9999. Time-of-day units must be in `[0, 24h)`; use Duration for 84,000 or 90,000 **elapsed** seconds. Unix timestamps represent instants; timezone formatting can change their displayed date. ISO date-only and clock-only values are civil fields: preserve them without shifting them across timezones. Do not turn a date-only value into the previous day in a western timezone. UTC is the deterministic default; `local` explicitly opts into the browser zone, and a valid IANA name supports an application-specific zone. Browser-local output differs between viewers by design when selected. Production should inherit caller locale for readable presets while keeping custom pattern tokens/ISO rules stable; the executable mockup uses English for reproducible previews.

Custom formats are a bounded token grammar, not JavaScript, HTML, SQL, regex or a dependency on Moment/date-fns:

- Duration: `{d}`, `{h}`, `{hh}`, `{m}`, `{mm}`, `{s}`, `{ss}`, `{ms}`. Hours are total hours unless `{d}` is present, then hours are the remainder within a day. Minutes/seconds are remainders, padded variants use two digits, milliseconds use three. `{h}h{m}m` produces `23h20m`; `{d}d {hh}:{mm}:{ss}.{ms}` can produce `1d 01:01:01.007`. Literal text is preserved, a single leading minus is applied to negative durations, and unknown/unclosed tokens are errors. Clock formatting includes fractional milliseconds when present.
- Date/time: `YYYY MM DD HH mm ss` matches the existing first-party `FORMAT_DATE` token spelling. Add `MMM MMMM ddd hh SSS A Z` for month names, weekday, 12-hour hour, milliseconds, AM/PM and numeric UTC offset. `[literal words]` escapes literal words, e.g. `MMM DD, YYYY [at] hh:mm A`. Validate tokens and balanced literal sections. Date output uses calendar fields in the chosen zone; no formula is reevaluated for presentation.

Patterns are limited to 160 characters. Invalid patterns/timezones block Apply with a specific formatting message. Per-value decode/format failures render **Invalid format**, remain separate from expression/group errors, and never become zero/NULL; the raw example and inspect show the original result. NULL stays `—`. Pattern output is always escaped text. The editor retains the numeric decimal setting when switching types and initializes sensible source units and presets for the newly selected type; source values, expression text and aggregate errors stay intact.

Proposed query-local presentation contract (not a new exported API yet):

```ts
type MetricValueFormat =
  | { kind: "number" | "percent"; decimals: number }
  | { kind: "duration"; sourceUnit: "milliseconds" | "seconds" | "minutes" | "hours" | "days";
      style: "human" | "long" | "clock" | "custom"; pattern?: string }
  | { kind: "date" | "time" | "datetime";
      sourceUnit: "iso" | "epochSeconds" | "epochMilliseconds" | "secondsOfDay" | "millisecondsOfDay";
      style: "human" | "iso" | "custom"; pattern?: string; timeZone: string };
// secondsOfDay/millisecondsOfDay are admitted only for kind:"time".
// display.valueFormat: MetricValueFormat
// display.scatter.xFormat/yFormat: independent MetricValueFormat
```

Version and validate this along with query URL/saved-query formats. Legacy number/percent keeps its existing meaning; a legacy duration renderer retains milliseconds. Preserve unused formatting fields when changing displays. Store semantic units/pattern/timezone with the metric, while the host owns locale/default presets and overrides. Use a shared pure formatter returning `{text,error?,raw?}`, consumed by scalar cards, table/list/pivot values, axis ticks, tooltips and accessible data tables. A host formatter callback can be a later styling escape hatch, not serialized executable code. Presentation props live in the UI package, not the SQL AST or remote request plan.

Formatting is excluded from computation/cache keys. Group ordering, ranking, point coordinates, pie denominators and all server arithmetic continue using the raw typed results. Unit conversion never changes the aggregate expression and never sorts formatted strings. Duration is usable on numeric charts; its value/axis labels are formatted consistently, while pie share percentages still describe the original quantity. ISO string calendar outputs initially use scalar/table/list/pivot. Calendar bars/pies are rejected: zero-based timestamp bars and additive sums of instants are misleading. Numeric instant scatter axes may format Unix coordinates independently; string-to-coordinate conversion and calendar-valued line Y axes require a distinct scale contract before enabling them. Temporal **group key** tick formatting remains separate from measure-output formatting.

The prototype uses [metric-output-format.js](mockups/metric-output-format.js), native `Intl.DateTimeFormat`, and no new dependencies. The demo now includes duration/date/time fixtures; existing applied demo configurations are preserved, so formatting is available even if those new fixtures are absent from an older saved configuration. Verify unit changes, strict parsing, impossible dates, NULL/error channels, signed/zero/subsecond durations, 59→60 carries, hours >24, custom literal escaping, explicit epoch units, date-only preservation, actual-instant timezone/DST conversion, invalid patterns/zones, both scatter axes and Apply/Cancel/refresh. Formatting changes must start no workers/remote requests and preserve raw sort/coordinate values.
