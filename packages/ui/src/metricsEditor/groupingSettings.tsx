// "Grouping" settings of the definition pane: group-by fields and date
// bucketing. Plain render function, not a component.
import {
  MAX_METRIC_DATE_EVERY,
  METRIC_HOUR_EVERY,
  metricMinCount,
  metricMinCountMeasure,
  type AggregationClause,
  type MetricDateGrouping,
} from "@pythia-software/query-table-core";
import { MetricNumberInput, Settings } from "./controls";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The "Grouping" settings of the selected metric. */
export function renderGroupingSettings<Row>(
  state: MetricsEditorState<Row>,
  selected: AggregationClause,
) {
  const {
    fields, groupable, titleId, settingsState, dateField, patch, regroup,
  } = state;
  return (
    <Settings
      title="Grouping"
      {...settingsState("Grouping")}
      summary={
        selected.groupBy.length
          ? selected.groupBy
              .map(
                (g) => fields.find((f) => f.name === g)?.label ?? g,
              )
              .join(" × ") +
            (selected.dateGrouping
              ? ` · ${(selected.dateGrouping.every ?? 1) > 1 ? `every ${selected.dateGrouping.every} ${selected.dateGrouping.interval}s` : selected.dateGrouping.interval} · ${selected.dateGrouping.timeZone ?? "UTC"}${selected.dateGrouping.includeEmpty ? " · empty dates" : ""}`
              : "")
          : "One value"
      }
    >
      {selected.groupBy.map((group, index) => (
        <div
          className="qt-metric-group-row"
          key={`${group}-${index}`}
        >
          <select
            aria-label={`Grouping ${index + 1}`}
            value={group}
            onChange={(e) => {
              const groupBy = [...selected.groupBy];
              groupBy[index] = e.target.value;
              regroup(groupBy);
            }}
          >
            {groupable.map((f) => (
              <option
                key={f.name}
                value={f.name}
                disabled={
                  f.name !== group &&
                  selected.groupBy.includes(f.name)
                }
              >
                {f.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={`Remove grouping ${index + 1}`}
            onClick={() =>
              regroup(
                selected.groupBy.filter((_, i) => i !== index),
              )
            }
          >
            ×
          </button>
          {index > 0 && (
            <button
              type="button"
              aria-label={`Move grouping ${index + 1} up`}
              onClick={() => {
                const groups = [...selected.groupBy];
                [groups[index], groups[index - 1]] = [
                  groups[index - 1]!,
                  groups[index]!,
                ];
                regroup(groups);
              }}
            >
              ↑
            </button>
          )}
        </div>
      ))}
      {dateField && (
        <div className="qt-metric-date-grouping">
          <label>
            Date interval
            <select
              aria-label="Date interval"
              value={selected.dateGrouping?.interval ?? "exact"}
              onChange={(e) => {
                if (e.target.value === "exact") {
                  patch(selected.id, {
                    dateGrouping: undefined,
                    window: undefined,
                  });
                  return;
                }
                const interval = e.target
                  .value as MetricDateGrouping["interval"];
                const cyclic =
                  interval === "hourOfDay" ||
                  interval === "dayOfWeek";
                // A new interval starts at one interval per
                // bucket: 6 hours must not become 6 months.
                const { occurrence, every: _every, ...previous } =
                  selected.dateGrouping ?? {};
                patch(selected.id, {
                  dateGrouping: {
                    field: dateField.name,
                    includeEmpty: false,
                    range: "query",
                    ...previous,
                    interval,
                    // Hour-of-day slots occur hourly.
                    ...(cyclic && occurrence
                      ? {
                          occurrence:
                            interval === "hourOfDay"
                              ? { ...occurrence, interval: "hour" }
                              : occurrence,
                        }
                      : {}),
                  },
                  // A window spans calendar intervals, not slots.
                  ...(cyclic ? { window: undefined } : {}),
                });
              }}
            >
              <option value="exact">Exact timestamp</option>
              <option value="hour">Hour</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              <option value="hourOfDay">Hour of day</option>
              <option value="dayOfWeek">Day of week</option>
            </select>
          </label>
          {selected.dateGrouping &&
            selected.dateGrouping.interval !== "hourOfDay" &&
            selected.dateGrouping.interval !== "dayOfWeek" && (
              <label className="qt-metric-date-every">
                Every
                {selected.dateGrouping.interval === "hour" ? (
                  // Hour buckets divide a day, aligned to local midnight.
                  <select
                    aria-label="Intervals per bucket"
                    title="Buckets of this many hours from each local midnight; the count divides a day"
                    value={selected.dateGrouping.every ?? 1}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const { every: _every, ...rest } =
                        selected.dateGrouping!;
                      patch(selected.id, {
                        dateGrouping: n > 1 ? { ...rest, every: n } : rest,
                      });
                    }}
                  >
                    {METRIC_HOUR_EVERY.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                ) : (
                  <MetricNumberInput
                    aria-label="Intervals per bucket"
                    title={`Buckets of this many ${selected.dateGrouping.interval}s, counted from 1970`}
                    min={1}
                    max={MAX_METRIC_DATE_EVERY}
                    step={1}
                    value={selected.dateGrouping.every ?? 1}
                    onCommit={(n) => {
                      const { every: _every, ...rest } =
                        selected.dateGrouping!;
                      patch(selected.id, {
                        dateGrouping: n > 1 ? { ...rest, every: n } : rest,
                      });
                    }}
                  />
                )}
                <span aria-hidden="true">
                  {selected.dateGrouping.interval}
                  {(selected.dateGrouping.every ?? 1) > 1 ? "s" : ""}
                </span>
              </label>
            )}
          {(selected.dateGrouping?.interval === "hourOfDay" ||
            selected.dateGrouping?.interval === "dayOfWeek") && (
            <>
              <label>
                Summarise each slot
                <select
                  aria-label="Summarise each slot"
                  value={
                    selected.dateGrouping.occurrence?.interval ??
                    "rows"
                  }
                  onChange={(e) => {
                    const {
                      occurrence,
                      partialIntervals: _partial,
                      ...rest
                    } = selected.dateGrouping!;
                    const value = e.target.value;
                    const perOccurrence = value === "hour" || value === "day";
                    patch(selected.id, {
                      // Per-occurrence summaries take no window or
                      // share, and count rows for their minimum.
                      ...(perOccurrence
                        ? {
                            window: undefined,
                            share: undefined,
                            ...(metricMinCountMeasure(selected) ? { minCount: metricMinCount(selected) } : {}),
                          }
                        : {}),
                      dateGrouping:
                        value === "hour" || value === "day"
                          ? {
                              ...rest,
                              occurrence: {
                                includeEmpty:
                                  occurrence?.includeEmpty ?? true,
                                interval: value,
                              },
                            }
                          : rest,
                    });
                  }}
                >
                  <option value="rows">Over all its rows</option>
                  {selected.dateGrouping.interval ===
                    "dayOfWeek" && (
                    <option value="day">Per whole day</option>
                  )}
                  <option value="hour">Per whole hour</option>
                </select>
              </label>
              {selected.dateGrouping.occurrence && (
                <label className="qt-metric-date-toggle">
                  <input
                    type="checkbox"
                    aria-label="Count idle occurrences"
                    checked={
                      selected.dateGrouping.occurrence.includeEmpty
                    }
                    onChange={(e) =>
                      patch(selected.id, {
                        dateGrouping: {
                          ...selected.dateGrouping!,
                          occurrence: {
                            ...selected.dateGrouping!.occurrence!,
                            includeEmpty: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  Count {selected.dateGrouping.occurrence.interval}s
                  without rows
                </label>
              )}
              <p className="qt-metric-help">
                {selected.dateGrouping.occurrence
                  ? `Each slot shows the mean of its whole ${selected.dateGrouping.occurrence.interval}s inside the date filters, or their spread as a box plot. Counts and sums are 0 for ${selected.dateGrouping.occurrence.interval}s without rows; averages and ratios leave them out.`
                  : "Each slot pools every row at that local hour or weekday."}
              </p>
            </>
          )}
          {selected.dateGrouping && (
            <label>
              Grouping timezone
              <input
                aria-label="Grouping timezone"
                list={`${titleId}-grouping-timezones`}
                maxLength={80}
                value={selected.dateGrouping.timeZone ?? "UTC"}
                placeholder="UTC or America/Denver"
                onChange={(e) =>
                  patch(selected.id, {
                    dateGrouping: {
                      ...selected.dateGrouping!,
                      timeZone: e.target.value,
                    },
                  })
                }
              />
              <datalist id={`${titleId}-grouping-timezones`}>
                {[
                  "UTC",
                  "America/Denver",
                  "America/Los_Angeles",
                  "America/New_York",
                  "Europe/London",
                  "Europe/Berlin",
                  "Asia/Kolkata",
                  "Asia/Tokyo",
                  "Australia/Sydney",
                  "Pacific/Auckland",
                ].map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
          )}
          <label className="qt-metric-date-toggle">
            <input
              type="checkbox"
              aria-label="Include empty dates"
              disabled={!selected.dateGrouping}
              checked={selected.dateGrouping?.includeEmpty ?? false}
              onChange={(e) =>
                patch(selected.id, {
                  dateGrouping: {
                    ...selected.dateGrouping!,
                    includeEmpty: e.target.checked,
                  },
                })
              }
            />
            Include empty dates
          </label>
          <p className="qt-metric-help">
            Add a bucket for every interval, even when no rows
            match.
          </p>
          {selected.dateGrouping &&
            ((selected.dateGrouping.interval === "hourOfDay" ||
            selected.dateGrouping.interval === "dayOfWeek")
              ? selected.dateGrouping.occurrence?.includeEmpty
              : selected.dateGrouping.includeEmpty) && (
            <>
              <label>
                Complete dates across
                <select
                  aria-label="Complete dates across"
                  value={selected.dateGrouping.range}
                  onChange={(e) =>
                    patch(selected.id, {
                      dateGrouping: {
                        ...selected.dateGrouping!,
                        range: e.target
                          .value as MetricDateGrouping["range"],
                      },
                    })
                  }
                >
                  <option value="query">Query date range</option>
                  <option value="observed">
                    First to last observed date
                  </option>
                  <option value="custom">Custom date range</option>
                </select>
              </label>
              {selected.dateGrouping.range === "custom" && (
                <div className="qt-metric-date-bounds">
                  <label>
                    From
                    <input
                      type="date"
                      aria-label="Empty dates start"
                      value={selected.dateGrouping.start ?? ""}
                      onChange={(e) =>
                        patch(selected.id, {
                          dateGrouping: {
                            ...selected.dateGrouping!,
                            start: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Through
                    <input
                      type="date"
                      aria-label="Empty dates end"
                      value={selected.dateGrouping.end ?? ""}
                      onChange={(e) =>
                        patch(selected.id, {
                          dateGrouping: {
                            ...selected.dateGrouping!,
                            end: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                </div>
              )}
              <p className="qt-metric-help">
                Direct counts and sums use 0 for empty dates.
                Averages, ratios, and other expressions have no
                value.
              </p>
            </>
          )}
          <label className="qt-metric-date-toggle">
            <input
              type="checkbox"
              aria-label="Whole intervals only"
              disabled={
                !selected.dateGrouping ||
                !!selected.dateGrouping.occurrence
              }
              checked={
                selected.dateGrouping?.partialIntervals ===
                "exclude"
              }
              onChange={(e) => {
                const { partialIntervals: _partial, ...rest } =
                  selected.dateGrouping!;
                patch(selected.id, {
                  dateGrouping: e.target.checked
                    ? { ...rest, partialIntervals: "exclude" }
                    : rest,
                });
              }}
            />
            Whole intervals only
          </label>
          <p className="qt-metric-help">
            Leave out intervals the date filters cut short and the
            interval still in progress.
          </p>
          <p className="qt-metric-help">
            Calendar boundaries and custom dates use the grouping
            timezone. Weeks begin Monday.
          </p>
        </div>
      )}
      <select
        aria-label="Add grouping"
        value=""
        onChange={(e) => {
          if (e.target.value)
            patch(selected.id, {
              groupBy: [...selected.groupBy, e.target.value],
            });
        }}
      >
        <option value="">+ Add grouping</option>
        {groupable
          .filter((f) => !selected.groupBy.includes(f.name))
          .map((f) => (
            <option key={f.name} value={f.name}>
              {f.label}
            </option>
          ))}
      </select>
    </Settings>
  );
}
