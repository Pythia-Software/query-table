import { expect, it } from "vitest";
import {
  EMPTY_QUERY,
  type FieldSchema,
  type QueryState,
} from "@pythia-software/query-table-core";
import { executeMetrics } from "../src/metricExecution";
import { memoryV3Transport, metricRequests } from "./v3Transport";

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
it("fills from the complete local dataset without a transport", async () => {
  const r = await executeMetrics(query, { schema, clientRows: rows });
  expect(r.metrics[0]!.buckets.map((b) => b.value)).toEqual([0, 1, 0, 0]);
});
it("fills calendar intervals on a v3 server from the query bounds", async () => {
  const transport = memoryV3Transport(rows, schema);
  const r = await executeMetrics(query, { schema, transport, now: Date.parse("2026-10-10T00:00:00Z") });
  expect(r.metrics[0]!.buckets.map((b) => b.value)).toEqual([0, 1, 0, 0]);
  expect(metricRequests(transport)).toHaveLength(1);
  expect(metricRequests(transport)[0]!.metrics[0]!.dateGrouping).toMatchObject({ field: "at", interval: "day" });
});
it("fails unsupported server date grouping before dispatch", async () => {
  const transport = memoryV3Transport(rows, schema, { capabilities: { calendarGrouping: false } });
  await expect(executeMetrics(query, { schema, transport })).rejects.toThrow("does not support calendar grouping");
  expect(transport.fetchQueryV3).not.toHaveBeenCalled();
});
it("uses the committed shown page locally while retaining the original filter bounds", async () => {
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
  });
  expect(r.metrics[0]!.processedRows).toBe(1);
  expect(r.metrics[0]!.buckets.map((b) => b.value)).toEqual([0, 1, 0, 0]);
});
