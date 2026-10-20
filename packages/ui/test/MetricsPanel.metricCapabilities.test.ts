// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  memoryComputedColumnStore,
  type FieldSchema,
  type Transport,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "@pythia-software/query-table-react";
import { MetricsPanel } from "../src/MetricsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());

it("lets a client-row host select and apply a computed grouping advertised by its metric handshake", async () => {
  vi.useFakeTimers();
  type Row = { id: number; group: string };
  const schema: FieldSchema<Row> = {
    name: "metric-editor-capabilities", idField: "id",
    fields: [
      { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
      { name: "group", label: "Group", type: "text", source: { kind: "backend" } },
    ],
  };
  const store = memoryComputedColumnStore();
  const definition = await store.save(schema.name, {
    id: "category", label: "Category",
    expression: { language: "qt-expr", version: 1, source: "[group]" },
  }, null);
  const fetchRows = vi.fn(async (): Promise<{ rows: Row[]; total: number }> => { throw Error("Metric transport cannot fetch rows"); });
  const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(async request => ({
    metrics: request.metrics.map(m => ({ id: m.id, buckets: [{ keys: [], value: 1, count: 1 }] })),
  }));
  const options: UseQueryTableOptions<Row> = {
    schema, clientRows: [{ id: 1, group: "a" }], computedColumnStore: store,
    metricTransport: { fetchRows, fetchMetrics, metricCapabilities: { version: 2, computedFields: true, expressions: true } },
    metricExecution: {
      profile: "qt-postgres-v1", planToken: "metric-plan", resolvedRevisions: { category: definition.revision },
      fields: { "@computed/category": { type: "text", select: false, sort: false, group: true, measure: false } },
    },
    debounceMs: 0, initialQuery: { ...EMPTY_QUERY, aggregations: [{ id: "m", op: "count", groupBy: [] }] },
  };
  let api!: QueryTableApi<Row>;
  function Probe() {
    api = useQueryTable(options);
    return createElement(MetricsPanel<Row>, { api, aggregations: api.aggregations, fields: api.computed.catalogue });
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit metrics"]')!.click());
    await act(async () => {});
    const grouping = document.querySelector<HTMLSelectElement>('[aria-label="Add grouping"]')!;
    expect([...grouping.options].map(option => [option.value, option.text])).toContainEqual(["@computed/category", "Category"]);
    act(() => {
      grouping.value = "@computed/category";
      grouping.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const apply = [...document.querySelectorAll("button")].find(button => button.textContent === "Apply metrics")!;
    expect(apply.disabled).toBe(false);
    act(() => apply.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(api.aggregations.clauses[0]?.groupBy).toEqual(["@computed/category"]);
    expect(fetchMetrics.mock.lastCall![0]).toMatchObject({
      metrics: [{ id: "m", groupBy: ["@computed/category"] }],
      expectedRevisions: { category: definition.revision },
    });
    expect(fetchRows).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount()); host.remove();
  }
});
