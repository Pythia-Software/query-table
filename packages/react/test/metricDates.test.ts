import { expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  type FieldSchema,
  type QueryState,
} from "@pythia-software/query-table-core";
import { executeMetrics } from "../src/metricExecution";

const schema: FieldSchema = {
  name: "date-metrics",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    {
      name: "at",
      label: "Date",
      type: "datetime",
      source: { kind: "backend" },
      aggregate: { groupable: true },
    },
  ],
};
const query: QueryState = {
  ...EMPTY_QUERY,
  where: [
    { field: "at", op: ">=", value: "2026-10-01" },
    { field: "at", op: "<", value: "2026-10-05" },
  ],
  aggregations: [
    {
      id: "dates",
      op: "count",
      groupBy: ["at"],
      expression: "COUNT()",
      dateGrouping: {
        field: "at",
        interval: "day",
        includeEmpty: true,
        range: "query",
      },
    },
  ],
};
const rows = [{ id: 1, at: "2026-10-02T11:00:00Z" }];
it("fills from the complete local dataset even with a rows-only transport", async () => {
  const fetchRows = vi.fn(async () => ({ rows, total: 1 }));
  const r = await executeMetrics(query, {
    schema,
    clientRows: rows,
    transport: { fetchRows },
  });
  expect(r.metrics[0]!.buckets.map((b) => b.value)).toEqual([0, 1, 0, 0]);
  expect(fetchRows).not.toHaveBeenCalled();
});
it("rejects unsupported server date grouping before dispatch", async () => {
  const fetchMetrics = vi.fn(async () => ({ metrics: [] }));
  await expect(
    executeMetrics(query, {
      schema,
      transport: {
        fetchRows: async () => ({ rows, total: 1 }),
        fetchMetrics,
        metricCapabilities: { version: 2 },
      },
    }),
  ).rejects.toThrow("does not support");
  expect(fetchMetrics).not.toHaveBeenCalled();
});
it("uses the committed shown page locally while retaining the original filter bounds", async () => {
  const fetchMetrics = vi.fn(async () => ({ metrics: [] }));
  const q: QueryState = {
    ...query,
    offset: 30,
    limit: 1,
    aggregations: [{ ...query.aggregations![0]!, scope: "shownRows" }],
  };
  const r = await executeMetrics(q, {
    schema,
    rowsReady: true,
    shownRows: rows,
    transport: {
      fetchRows: async () => ({ rows, total: 100 }),
      fetchMetrics,
      metricCapabilities: { version: 2, shownRows: true },
    },
  });
  expect(r.metrics[0]!.processedRows).toBe(1);
  expect(r.metrics[0]!.buckets.map((b) => b.value)).toEqual([0, 1, 0, 0]);
  expect(fetchMetrics).not.toHaveBeenCalled();
});
