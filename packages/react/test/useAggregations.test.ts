// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  type FieldSchema,
  type QueryState,
} from "@pythia-software/query-table-core";
import { useAggregations, type AggregationsApiState } from "../src/useAggregations";

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});
beforeEach(() => vi.useFakeTimers());
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: number; value: number }
const schema: FieldSchema<Row> = {
  name: "standalone-metrics", idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "value", label: "Value", type: "number", source: { kind: "backend" } },
  ],
};
const clientRows: Row[] = [{ id: 1, value: 2 }, { id: 2, value: 3 }, { id: 3, value: 7 }];
const query: QueryState = {
  ...EMPTY_QUERY,
  where: [{ field: "value", op: ">", value: "1" }],
  orderBy: [{ field: "value", dir: "desc" }], offset: 1, limit: 2,
  aggregations: [{ id: "shown", op: "sum", field: "value", groupBy: [], scope: "shownRows" }],
};
let root: Root | undefined;
function mount(rows: Row[], rowsReady?: boolean) {
  const current = { api: undefined as unknown as AggregationsApiState };
  function Probe({ ready }: { ready: boolean | undefined }) {
    current.api = useAggregations(query, schema, undefined, rows, 0, 0, undefined,
      ready === undefined ? undefined : { rowsReady: ready });
    return null;
  }
  root = createRoot(document.createElement("div"));
  const rerender = (ready?: boolean) => act(() => root!.render(createElement(Probe, { ready })));
  rerender(rowsReady);
  return { current, rerender };
}
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

it("evaluates standalone shown-row metrics with default options and the current client page", async () => {
  const { current } = mount(clientRows);
  await settle();
  expect(current.api.loading).toBe(false);
  expect(current.api.error).toBeNull();
  expect(current.api.results?.metrics[0]?.buckets[0]?.value).toBe(5);
  await expect(current.api.preview(query.aggregations!)).resolves.toEqual(current.api.results);
});

it("does not wait forever on an empty complete client dataset", async () => {
  const { current } = mount([]);
  await settle();
  expect(current.api.loading).toBe(false);
  expect(current.api.error).toBeNull();
  expect(current.api.results?.metrics[0]?.processedRows).toBe(0);
});

it("retains an explicit false readiness gate and recovers when the override is removed", async () => {
  const { current, rerender } = mount(clientRows, false);
  await settle();
  expect(current.api.loading).toBe(true);
  expect(current.api.results).toBeNull();
  await expect(current.api.preview(query.aggregations!)).rejects.toThrow("current table page");
  rerender(); await settle();
  expect(current.api.loading).toBe(false);
  expect(current.api.results?.metrics[0]?.buckets[0]?.value).toBe(5);
  rerender(false);
  expect(current.api.results).toBeNull();
  await expect(current.api.preview(query.aggregations!)).rejects.toThrow("current table page");
});
