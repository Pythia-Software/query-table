import type {
  AggregationBucket,
  AggregationClause,
  FieldDef,
} from "@pythia-software/query-table-core";

/** Proposed definition shape, isolated from the production query contract. */
export interface DateMetricDefinition extends AggregationClause {
  dateGrouping: {
    field: "placed_at";
    interval: "day" | "week" | "month";
    includeEmpty: boolean;
    range: "query" | "observed" | "custom";
    start: string;
    end: string;
  };
}

export const QUERY_RANGE = { start: "2026-10-01", end: "2026-10-14" };
export const DATE_METRIC_FIELDS: FieldDef[] = [
  {
    name: "placed_at",
    label: "Order date",
    type: "datetime",
    source: { kind: "backend" },
    aggregate: { groupable: true },
  },
  {
    name: "total",
    label: "Order value ($)",
    type: "number",
    source: { kind: "backend" },
  },
];
export const INITIAL_DATE_METRIC: DateMetricDefinition = {
  id: "orders-over-time",
  label: "Orders over time",
  op: "count",
  expression: "COUNT()",
  groupBy: ["placed_at"],
  scope: "allMatching",
  display: {
    kind: "line",
    xFormat: {
      kind: "date",
      style: "custom",
      pattern: "MMM DD",
      timeZone: "UTC",
    },
  },
  dateGrouping: {
    field: "placed_at",
    interval: "day",
    includeEmpty: false,
    range: "query",
    ...QUERY_RANGE,
  },
};
export interface ExampleOrder {
  placed_at: string;
  total: number;
}
export const EXAMPLE_ORDERS: ExampleOrder[] = [
  [2, 12],
  [3, 18],
  [6, 8],
  [7, 24],
  [10, 14],
  [12, 9],
  [13, 11],
].flatMap(([day, count], group) =>
  Array.from({ length: count! }, (_, i) => ({
    placed_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    total: 40 + group * 9 + i * 5,
  })),
);

const dayTime = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw Error("Choose a valid start and end date.");
  return date.getTime();
};
function floor(
  time: number,
  interval: DateMetricDefinition["dateGrouping"]["interval"],
): number {
  const d = new Date(time);
  d.setUTCHours(0, 0, 0, 0);
  if (interval === "week")
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (interval === "month") d.setUTCDate(1);
  return d.getTime();
}
function next(
  time: number,
  interval: DateMetricDefinition["dateGrouping"]["interval"],
): number {
  const d = new Date(time);
  if (interval === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (interval === "week" ? 7 : 1));
  return d.getTime();
}

/** Complete fixture population; never called on a paginated/truncated response. */
export function previewDateMetric(
  definition: DateMetricDefinition,
  orders: readonly ExampleOrder[],
) {
  const config = definition.dateGrouping;
  const start = dayTime(
    config.range === "custom" ? config.start : QUERY_RANGE.start,
  );
  const end = dayTime(config.range === "custom" ? config.end : QUERY_RANGE.end);
  if (end < start)
    throw Error("The end date must be on or after the start date.");
  const groups = new Map<number, ExampleOrder[]>();
  const matching = orders.filter((order) => {
    const time = Date.parse(order.placed_at);
    return time >= start && time < end + 86400000;
  });
  for (const order of matching) {
    const key = floor(Date.parse(order.placed_at), config.interval);
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const observed = [...groups.keys()].sort((a, b) => a - b);
  const min =
    config.range === "observed" ? observed[0] : floor(start, config.interval);
  const max =
    config.range === "observed"
      ? observed[observed.length - 1]
      : floor(end, config.interval);
  const times = [...observed];
  if (config.includeEmpty && min !== undefined && max !== undefined) {
    times.length = 0;
    for (let time = min; time <= max; time = next(time, config.interval)) {
      if (times.length >= 400)
        throw Error(
          "This prototype supports up to 400 date buckets. Choose a shorter range or a larger interval.",
        );
      times.push(time);
    }
  }
  const buckets: AggregationBucket[] = times.map((time) => {
    const rows = groups.get(time) ?? [];
    const sum = rows.reduce((total, row) => total + row.total, 0);
    return {
      keys: [new Date(time).toISOString().slice(0, 10)],
      count: rows.length,
      value:
        definition.op === "count"
          ? rows.length
          : definition.op === "sum"
            ? sum
            : rows.length
              ? sum / rows.length
              : null,
    };
  });
  const extentMin = min ?? floor(start, config.interval),
    extentMax = max ?? floor(end, config.interval);
  return {
    buckets,
    matchingRows: matching.length,
    emptyBuckets: buckets.filter((b) => b.count === 0).length,
    extent: {
      min: extentMin,
      max:
        extentMax === extentMin ? next(extentMax, config.interval) : extentMax,
    },
  };
}
