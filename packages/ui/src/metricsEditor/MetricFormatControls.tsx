// Value-format controls (number, percent, currency, durations, dates) with a live sample.
import { type ReactNode } from "react";
import {
  type AggregationBucket,
  type MetricValueFormat,
} from "@pythia-software/query-table-core";
import { formatMetricOutput } from "../metricFormat";
import { MetricNumberInput } from "./controls";

export function MetricFormatControls({
  format,
  onChange,
  displayControl,
  sample,
  locale,
}: {
  displayControl?: ReactNode;
  sample?: AggregationBucket["value"] | undefined;
  locale?: string | undefined;
  format: MetricValueFormat;
  onChange: (format: MetricValueFormat) => void;
}) {
  const temporal = !["number", "percent", "currency"].includes(format.kind),
    duration = format.kind === "duration",
    compact = format.notation === "compact" && (format.kind === "number" || format.kind === "currency"),
    // Decimals may be left unset: currency uses its own minor units and
    // compact output shows at most one.
    autoDecimals = format.kind === "currency" || compact;
  const patch = (values: Partial<MetricValueFormat>) =>
    onChange({ ...format, ...values });
  const units: Array<[NonNullable<MetricValueFormat["sourceUnit"]>, string]> =
    duration
      ? [
          ["milliseconds", "Milliseconds"],
          ["seconds", "Seconds"],
          ["minutes", "Minutes"],
          ["hours", "Hours"],
          ["days", "Days"],
        ]
      : [
          ["iso", "ISO text"],
          ["epochSeconds", "Unix seconds"],
          ["epochMilliseconds", "Unix milliseconds"],
          ...(format.kind === "time"
            ? ([
                ["secondsOfDay", "Seconds since midnight"],
                ["millisecondsOfDay", "Milliseconds since midnight"],
              ] as Array<
                [NonNullable<MetricValueFormat["sourceUnit"]>, string]
              >)
            : []),
        ];
  return (
    <div
      className={`qt-metric-format-controls${temporal ? " qt-metric-format-controls--temporal" : ""}`}
    >
      {displayControl}
      <label>
        Output type
        <select
          aria-label="Metric output type"
          value={format.kind}
          onChange={(e) => {
            const kind = e.target.value as MetricValueFormat["kind"];
            // Currency starts at its own minor units (Auto decimals).
            onChange(
              kind === "currency"
                ? { kind, currency: format.currency ?? "USD", ...(format.notation === "compact" ? { notation: "compact" as const } : {}) }
                : {
                    kind,
                    decimals: format.decimals ?? 0,
                    sourceUnit: kind === "duration" ? "milliseconds" : "iso",
                    style: "human",
                    timeZone: "UTC",
                  },
            );
          }}
        >
          {(
            [
              "number",
              "percent",
              "currency",
              "duration",
              "date",
              "time",
              "datetime",
            ] as const
          ).map((kind) => (
            <option key={kind} value={kind}>
              {
                {
                  number: "Number",
                  percent: "Percent",
                  currency: "Currency",
                  duration: "Duration",
                  date: "Date",
                  time: "Time",
                  datetime: "Date & time",
                }[kind]
              }
            </option>
          ))}
        </select>
      </label>
      {!temporal && (autoDecimals ? (
        <label>
          Decimals
          <MetricNumberInput
            aria-label="Metric decimals"
            min={0}
            max={6}
            step={1}
            allowEmpty
            placeholder="Auto"
            title={compact ? "At most this many decimals; Auto shows at most 1" : "Auto uses the currency's own decimals"}
            value={format.decimals}
            onCommit={(n) => {
              if (n === undefined) {
                const { decimals: _decimals, ...rest } = format;
                onChange(rest);
              } else if (Number.isInteger(n) && n >= 0 && n <= 6) patch({ decimals: n });
            }}
          />
        </label>
      ) : (
        <label>
          Decimals
          <MetricNumberInput
            aria-label="Metric decimals"
            min={0}
            max={6}
            step={1}
            value={format.decimals ?? 0}
            onCommit={(n) => {
              if (Number.isInteger(n) && n >= 0 && n <= 6)
                patch({ decimals: n });
            }}
          />
        </label>
      ))}
      {format.kind === "currency" && (
        <label>
          Currency
          <input
            aria-label="Metric currency code"
            maxLength={3}
            pattern="[A-Z]{3}"
            placeholder="USD"
            value={format.currency ?? ""}
            onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
          />
        </label>
      )}
      {(format.kind === "number" || format.kind === "currency") && (
        <label className="qt-metric-format-check">
          <input
            type="checkbox"
            aria-label="Compact notation"
            checked={compact}
            onChange={(e) => {
              const { notation: _notation, decimals: _decimals, ...rest } = format;
              // Compact decimals are a maximum; start from Auto (at most 1).
              onChange(e.target.checked ? { ...rest, notation: "compact" } : { ...rest, ...(format.kind === "number" ? { decimals: 0 } : {}) });
            }}
          />
          {format.kind === "currency" ? "Compact ($1.2M)" : "Compact (1.2K, 3.4M)"}
        </label>
      )}
      {temporal && (
        <div className="qt-metric-temporal-controls">
          <label>
            Source units / encoding
            <select
              aria-label="Source units"
              value={format.sourceUnit ?? (duration ? "milliseconds" : "iso")}
              onChange={(e) =>
                patch({
                  sourceUnit: e.target.value as NonNullable<
                    MetricValueFormat["sourceUnit"]
                  >,
                })
              }
            >
              {units.map(([unit, label]) => (
                <option value={unit} key={unit}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label format
            <select
              aria-label="Label format"
              value={format.style ?? "human"}
              onChange={(e) =>
                patch({
                  style: e.target.value as NonNullable<
                    MetricValueFormat["style"]
                  >,
                  pattern:
                    format.pattern ??
                    (duration
                      ? "{h}h{m}m"
                      : format.kind === "time"
                        ? "HH:mm:ss"
                        : format.kind === "date"
                          ? "YYYY-MM-DD"
                          : "YYYY-MM-DD HH:mm:ss"),
                })
              }
            >
              <option value="human">
                {duration
                  ? "Human readable"
                  : format.kind === "time"
                    ? "24-hour"
                    : "Readable"}
              </option>
              {duration ? (
                <>
                  <option value="long">Long</option>
                  <option value="clock">Clock · total hours</option>
                </>
              ) : (
                <option value="iso">{"ISO-style"}</option>
              )}
              <option value="custom">Custom format string</option>
            </select>
          </label>
          {format.style === "custom" && (
            <label>
              Format string
              <input
                aria-label="Output format string"
                maxLength={160}
                value={format.pattern ?? ""}
                onChange={(e) => patch({ pattern: e.target.value })}
              />
              <span className="qt-muted">
                {duration
                  ? "{d} {h} {hh} {m} {mm} {s} {ss} {ms}"
                  : "YYYY MM DD MMM MMMM ddd HH hh mm ss SSS A Z; [literal text]"}
              </span>
            </label>
          )}
          {!duration &&
            !["secondsOfDay", "millisecondsOfDay"].includes(
              format.sourceUnit ?? "",
            ) && (
              <label>
                Timezone
                <input
                  aria-label="Output timezone"
                  maxLength={80}
                  value={format.timeZone ?? "UTC"}
                  placeholder="UTC, local, or America/Denver"
                  onChange={(e) => patch({ timeZone: e.target.value })}
                />
              </label>
            )}
        </div>
      )}
      <div className="qt-metric-format-example">
        <span>Format example</span>
        <strong>
          {
            formatMetricOutput(
              sample === undefined
                ? format.kind === "date" || format.kind === "datetime"
                  ? "2026-10-08T14:30:00Z"
                  : format.kind === "time"
                    ? "14:30:00"
                    : format.kind === "duration"
                      ? 83400
                      : format.kind === "currency" || compact
                        ? 1234567.89
                        : 0.875
                : sample,
              format,
              locale,
            ).text
          }
        </strong>
      </div>
    </div>
  );
}
