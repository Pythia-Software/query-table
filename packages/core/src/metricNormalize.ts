import type { AggregationClause } from "./query";
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
    specs: Record<
      string,
      readonly string[] | "string" | "boolean" | "integer" | "number"
    >,
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
              : spec === "integer"
                ? typeof v === "number" &&
                  Number.isSafeInteger(v) &&
                  v >= 0 &&
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
    copy(raw, {
      expression: "string",
      expressionY: "string",
      scope: ["allMatching", "shownRows"],
      groupLimit: "integer",
    }),
  );
  if (raw.display !== undefined) {
    if (record(raw.display)) {
      if (typeof raw.display.kind !== "string")
        diagnostics.push("Invalid metric display kind.");
      const d = copy(raw.display, {
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
        boxMean: "boolean",
      });
      for (const k of ["xScale", "yScale"]) {
        if (record(raw.display[k]))
          d[k] = copy(raw.display[k], {
            mode: ["linear", "log"],
            min: "number",
            max: "number",
          });
        else if (raw.display[k] !== undefined)
          diagnostics.push(`Invalid metric ${k}.`);
      }
      for (const k of ["format", "xFormat", "yFormat"])
        if (record(raw.display[k]))
          d[k] = copy(raw.display[k], {
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
          });
      if (record(raw.display.list))
        d.list = copy(raw.display.list, {
          showBars: "boolean",
          useGroupColors: "boolean",
          showValues: "boolean",
        });
      if (record(raw.display.pivot))
        d.pivot = copy(raw.display.pivot, {
          swap: "boolean",
          rowDir: ["asc", "desc"],
          columnDir: ["asc", "desc"],
        });
      out.display = { kind: "auto", ...d };
    } else diagnostics.push("Invalid metric display.");
  }
  if (raw.distribution !== undefined) {
    if (record(raw.distribution))
      out.distribution = copy(raw.distribution, {
        kind: ["box", "histogram"],
        input: "string",
        whiskers: ["minmax", "tukey"],
        bins: "integer",
      });
    else diagnostics.push("Invalid metric distribution.");
  }
  if (record(raw.layout)) {
    const l = copy(raw.layout, {
      widthRem: "integer",
      heightRem: "integer",
      minWidthRem: "integer",
      minHeightRem: "integer",
    });
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
