import type {
  AggregationClause,
  QueryState,
  FieldSchema,
} from "@pythia-software/query-table-core";
import { EMPTY_QUERY } from "@pythia-software/query-table-core";
import { EXAMPLE_ORDERS } from "./dateMetricExample";
import type { Run } from "./data";

export const DATE_EXAMPLE_RUNS: Run[] = EXAMPLE_ORDERS.map((order, i) => ({
  id: 2000 + i,
  job_name: ["checkout-flow", "invoice-export", "report-builder"][i % 3]!,
  platform: (["linux", "macos", "windows"] as const)[i % 3]!,
  overall: i % 5 === 0 ? "FAIL" : "PASS",
  total_ms: order.total * 1000,
  worker: `worker-${1 + (i % 4)}`,
  enqueued_at: order.placed_at,
  is_starred: false,
  error_codes: i % 5 === 0 ? ["timeout"] : null,
}));

const dateMetric = (
  id: string,
  label: string,
  expression: string,
): AggregationClause => ({
  id,
  label,
  op: "count",
  expression,
  groupBy: ["enqueued_at"],
  dateGrouping: {
    field: "enqueued_at",
    interval: "day",
    includeEmpty: true,
    range: "query",
  },
  display: {
    kind: "line",
    xLabel: "Enqueued date",
    yLabel: expression === "COUNT()" ? "Runs" : "Average duration",
    ...(expression === "COUNT()"
      ? {}
      : {
          format: {
            kind: "duration" as const,
            sourceUnit: "milliseconds" as const,
          },
        }),
  },
  layout: { widthRem: 34, heightRem: 18, minWidthRem: 18, minHeightRem: 12 },
});

export const DATE_EXAMPLE_METRICS: AggregationClause[] = [
  {
    id: "runs-in-range",
    label: "Runs in scope",
    op: "count",
    expression: "COUNT()",
    groupBy: [],
    display: { kind: "value" },
    layout: { widthRem: 12, heightRem: 7, minWidthRem: 10, minHeightRem: 6 },
  },
  dateMetric("daily-runs", "Runs by day", "COUNT()"),
  dateMetric("daily-duration", "Average duration by day", "AVG([total_ms])"),
];
export const DATE_EXAMPLE_QUERY: QueryState = {
  ...EMPTY_QUERY,
  where: [
    { field: "enqueued_at", op: ">=", value: "2026-10-01T00:00:00Z" },
    { field: "enqueued_at", op: "<", value: "2026-10-15T00:00:00Z" },
  ],
  aggregations: DATE_EXAMPLE_METRICS,
};

export function dateExampleSchema(schema: FieldSchema<Run>): FieldSchema<Run> {
  return {
    ...schema,
    name: "runs-date-metric-workbench",
    fields: schema.fields.map((field) =>
      field.name === "enqueued_at"
        ? {
            ...field,
            source: { kind: "backend", path: "enqueued_at" },
            aggregate: { ...field.aggregate, groupable: true },
          }
        : field,
    ),
  };
}
