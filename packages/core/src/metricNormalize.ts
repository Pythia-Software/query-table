import type { AggregationClause } from "./query";

/** How normalizeMetricOptions validates one option: an allowed value list or a type. */
export type MetricOptionSpec = readonly string[] | "string" | "boolean" | "integer" | "positiveInteger" | "number";

/** The option tables normalizeMetricOptions copies from, in output order. Other
 *  implementations of query links (the Go module) are checked against this
 *  table through schema/fixtures/metric-options.json. */
export const METRIC_OPTION_SPECS = {
  top: {
    expression: "string",
    expressionY: "string",
    scope: ["allMatching", "shownRows"],
    groupLimit: "integer",
    minCount: "positiveInteger",
    share: ["total", "group0"],
  },
  window: {
    reduce: ["total", "mean"],
    partial: ["omit", "include"],
  },
  dateGrouping: {
    field: "string",
    interval: [
      "hour",
      "day",
      "week",
      "month",
      "year",
      "hourOfDay",
      "dayOfWeek",
    ],
    timeZone: "string",
    includeEmpty: "boolean",
    range: ["query", "observed", "custom"],
    start: "string",
    end: "string",
    partialIntervals: ["include", "exclude"],
  },
  occurrence: {
    interval: ["hour", "day"],
    includeEmpty: "boolean",
  },
  display: {
    kind: [
      "auto",
      "value",
      "table",
      "list",
      "bar-horizontal",
      "bar-vertical",
      "line",
      "pie",
      "donut",
      "scatter",
      "box",
      "histogram",
    ],
    valueLabel: "string",
    xLabel: "string",
    yLabel: "string",
    legendPosition: ["left", "right", "top", "bottom", "none"],
    maxGroups: "positiveInteger",
    showOther: "boolean",
    boxMean: "boolean",
  },
  scale: {
    mode: ["linear", "log"],
    min: "number",
    max: "number",
  },
  format: {
    kind: ["number", "percent", "duration", "date", "time", "datetime"],
    decimals: "integer",
    sourceUnit: [
      "milliseconds",
      "seconds",
      "minutes",
      "hours",
      "days",
      "iso",
      "epochSeconds",
      "epochMilliseconds",
      "secondsOfDay",
      "millisecondsOfDay",
    ],
    style: ["human", "long", "clock", "custom", "iso"],
    pattern: "string",
    timeZone: "string",
  },
  list: {
    showBars: "boolean",
    useGroupColors: "boolean",
    showValues: "boolean",
    barPosition: ["inline", "below"],
    maxLabelLines: "positiveInteger",
  },
  pivot: {
    swap: "boolean",
    rowDir: ["asc", "desc"],
    columnDir: ["asc", "desc"],
  },
  distribution: {
    kind: ["box", "histogram"],
    input: "string",
    whiskers: ["minmax", "tukey"],
    bins: "integer",
  },
  layout: {
    widthRem: "integer",
    heightRem: "integer",
    minWidthRem: "integer",
    minHeightRem: "integer",
  },
} as const satisfies Record<string, Record<string, MetricOptionSpec>>;

/** Whitelist every nested property: URL/storage objects never become executable plans. */
export function normalizeMetricOptions(
  raw: Record<string, unknown>,
): Partial<AggregationClause> {
  const out: Record<string, unknown> = {},
    diagnostics: string[] = [];
  const record = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  const copy = (
    input: Record<string, unknown>,
    specs: Readonly<Record<string, MetricOptionSpec>>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(specs)) {
      const v = input[key];
      if (v === undefined) continue;
      if (
        spec === "string"
          ? typeof v === "string" && v.length <= 10000
          : spec === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : spec === "boolean"
              ? typeof v === "boolean"
              : spec === "integer" || spec === "positiveInteger"
                ? typeof v === "number" &&
                  Number.isSafeInteger(v) &&
                  v >= (spec === "positiveInteger" ? 1 : 0) &&
                  v <= 1000000
                : typeof v === "string" && spec.includes(v)
      )
        result[key] = v;
      else diagnostics.push(`Invalid metric ${key}.`);
    }
    return result;
  };
  Object.assign(
    out,
    copy(raw, METRIC_OPTION_SPECS.top),
  );
  if (raw.window !== undefined) {
    if (record(raw.window)) {
      const w = copy(raw.window, METRIC_OPTION_SPECS.window);
      const periods = raw.window.periods;
      if (periods === "all" || (Number.isSafeInteger(periods) && (periods as number) >= 0 && (periods as number) <= 1000000))
        w.periods = periods;
      else diagnostics.push("Invalid metric window.");
      out.window = w;
    } else diagnostics.push("Invalid metric window.");
  }
  if (raw.dateGrouping !== undefined) {
    if (record(raw.dateGrouping)) {
      const d = copy(raw.dateGrouping, METRIC_OPTION_SPECS.dateGrouping);
      if (
        typeof d.field !== "string" ||
        !d.field ||
        d.field.length > 256 ||
        !d.interval ||
        typeof d.includeEmpty !== "boolean" ||
        !d.range
      )
        diagnostics.push("Invalid metric date grouping.");
      const occurrence = raw.dateGrouping.occurrence;
      if (record(occurrence)) {
        const o = copy(occurrence, METRIC_OPTION_SPECS.occurrence);
        if (!o.interval || typeof o.includeEmpty !== "boolean")
          diagnostics.push("Invalid metric date grouping occurrence.");
        d.occurrence = o;
      } else if (occurrence !== undefined)
        diagnostics.push("Invalid metric date grouping occurrence.");
      out.dateGrouping = d;
    } else diagnostics.push("Invalid metric date grouping.");
  }
  if (raw.display !== undefined) {
    if (record(raw.display)) {
      if (typeof raw.display.kind !== "string")
        diagnostics.push("Invalid metric display kind.");
      const d = copy(raw.display, METRIC_OPTION_SPECS.display);
      for (const k of ["xScale", "yScale"]) {
        if (record(raw.display[k]))
          d[k] = copy(raw.display[k], METRIC_OPTION_SPECS.scale);
        else if (raw.display[k] !== undefined)
          diagnostics.push(`Invalid metric ${k}.`);
      }
      for (const k of ["format", "xFormat", "yFormat"])
        if (record(raw.display[k]))
          d[k] = copy(raw.display[k], METRIC_OPTION_SPECS.format);
      if (record(raw.display.list))
        d.list = copy(raw.display.list, METRIC_OPTION_SPECS.list);
      if (record(raw.display.pivot))
        d.pivot = copy(raw.display.pivot, METRIC_OPTION_SPECS.pivot);
      out.display = { kind: "auto", ...d };
    } else diagnostics.push("Invalid metric display.");
  }
  if (raw.distribution !== undefined) {
    if (record(raw.distribution))
      out.distribution = copy(raw.distribution, METRIC_OPTION_SPECS.distribution);
    else diagnostics.push("Invalid metric distribution.");
  }
  if (record(raw.layout)) {
    const l = copy(raw.layout, METRIC_OPTION_SPECS.layout);
    for (const k of ["widthRem", "heightRem", "minWidthRem", "minHeightRem"])
      l[k] = Math.max(1, Math.min(1000, Number(l[k] ?? 1)));
    l.widthRem = Math.max(Number(l.widthRem), Number(l.minWidthRem));
    l.heightRem = Math.max(Number(l.heightRem), Number(l.minHeightRem));
    out.layout = l;
  }
  if (raw.sort !== undefined && !Array.isArray(raw.sort))
    diagnostics.push("Invalid metric sort.");
  if (Array.isArray(raw.sort))
    out.sort = raw.sort.slice(0, 20).flatMap((s) => {
      if (
        !record(s) ||
        typeof s.key !== "string" ||
        !/^(value|y|count|samples|group(?:0|[1-9][0-9]?))$/.test(s.key) ||
        !["asc", "desc"].includes(String(s.dir))
      ) {
        diagnostics.push("Invalid metric sort.");
        return [];
      }
      return [
        copy(s, {
          key: [s.key],
          dir: ["asc", "desc"],
          nulls: ["first", "last"],
        }),
      ];
    });
  if (Array.isArray(raw.diagnostics))
    diagnostics.push(
      ...raw.diagnostics
        .filter((s): s is string => typeof s === "string" && s.length <= 1000)
        .slice(0, 20),
    );
  if (diagnostics.length) out.diagnostics = [...new Set(diagnostics)];
  return out as Partial<AggregationClause>;
}
