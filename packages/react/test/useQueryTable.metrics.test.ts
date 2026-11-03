// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  memoryComputedColumnStore,
  memoryStorageAdapter,
  isGroupable,
  readFieldValue,
  type AggregationResult,
  type ComputedExecution,
  type FieldSchema,
  type Transport,
  type QueryRequestV3,
  type QueryResultV3,
} from "@pythia-software/query-table-core";
import {
  useQueryTable,
  type QueryTableApi,
  type UseQueryTableOptions,
} from "../src/useQueryTable";
import { MEMORY_V3_CAPABILITIES, memoryV3Transport, metricRequests, rowRequests, serveQueryV3, v3Response } from "./v3Transport";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
interface Row {
  id: number;
  x: number;
  group: string;
}
const schema: FieldSchema<Row> = {
  name: "metric-hooks",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "x", label: "X", type: "number", source: { kind: "backend" } },
    {
      name: "group",
      label: "Group",
      type: "text",
      source: { kind: "backend" },
    },
  ],
};
const rows: Row[] = [
  { id: 1, x: 10, group: "a" },
  { id: 2, x: 20, group: "b" },
  { id: 3, x: 30, group: "a" },
];
let root: Root | undefined;
function mount(options: UseQueryTableOptions<Row>) {
  const current = { api: undefined as unknown as QueryTableApi<Row> };
  function Probe({ options }: { options: UseQueryTableOptions<Row> }) {
    current.api = useQueryTable(options);
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe, { options })));
  return {
    current,
    rerender: (next: UseQueryTableOptions<Row>) =>
      act(() => root!.render(createElement(Probe, { options: next }))),
  };
}
async function settle() {
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30);
  });
}
/** A v3 transport: row requests are served by `serveRows` (default: `rows`),
 * metric requests by `answer`. */
function v3Transport(options: {
  profile?: string;
  serveRows?: (request: QueryRequestV3, signal?: AbortSignal) => Promise<QueryResultV3>;
  answer?: (request: QueryRequestV3, signal?: AbortSignal) => Promise<QueryResultV3>;
} = {}) {
  const fetchQueryV3 = vi.fn(async (request: QueryRequestV3, signal?: AbortSignal): Promise<QueryResultV3> => request.rows
    ? (options.serveRows ?? (async (r) => serveQueryV3(rows, schema, r)))(request, signal)
    : (options.answer ?? (async (r) => v3Response(r, { metrics: r.metrics.map(m => ({ id: m.id, buckets: [] })) })))(request, signal));
  return { queryCapabilities: { ...MEMORY_V3_CAPABILITIES, ...(options.profile ? { profile: options.profile } : {}) }, fetchQueryV3 } satisfies Transport<Row>;
}
/** A v3 page whose rows carry the server-computed `@computed/double` inline. */
function computedPage(request: QueryRequestV3, page: (Row & { "@computed/double"?: unknown })[], total = page.length) {
  return v3Response(request, { rows: page as unknown as Record<string, unknown>[], total,
    schema: { name: schema.name, idField: "id", fields: [...schema.fields.map(({ name, type }) => ({ name, type })), { name: "@computed/double", type: "number" }] } });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});
describe("transactional metrics controller", () => {
  it("still reports query validation failures while a shown-row page is unavailable", async () => {
    const transport = memoryV3Transport(rows, schema);
    const { current } = mount({
      schema,
      transport,
      debounceMs: 0,
      validateQuery: () => {
        throw Error("Unavailable filter value");
      },
      initialQuery: {
        ...EMPTY_QUERY,
        aggregations: [
          { id: "shown", op: "count", groupBy: [], scope: "shownRows" },
        ],
      },
    });
    await settle();
    expect(current.api.error?.message).toBe("Unavailable filter value");
    expect(current.api.aggregations.error?.message).toBe(
      "Unavailable filter value",
    );
    expect(current.api.aggregations.loading).toBe(false);
    expect(transport.fetchQueryV3).not.toHaveBeenCalled();
  });
  it("previews without mutation, commits once, and restores complete nested presentation on undo", async () => {
    const { current } = mount({
      schema,
      clientRows: rows,
      initialQuery: { ...EMPTY_QUERY, limit: 1 },
      debounceMs: 0,
    });
    await settle();
    const clauses = [
      {
        id: "all",
        op: "sum" as const,
        field: "x",
        groupBy: [],
        display: {
          kind: "value" as const,
          format: { kind: "duration" as const, sourceUnit: "seconds" as const },
        },
        layout: { widthRem: 12, heightRem: 6, minWidthRem: 8, minHeightRem: 4 },
      },
      {
        id: "page",
        op: "sum" as const,
        field: "x",
        groupBy: [],
        scope: "shownRows" as const,
      },
    ];
    const preview = await current.api.aggregations.preview!(clauses);
    expect(preview.metrics.map((m) => m.buckets[0]?.value)).toEqual([60, 10]);
    expect(current.api.query.aggregations).toBeUndefined();
    act(() => current.api.aggregations.replace!(clauses, []));
    await settle();
    act(() =>
      current.api.aggregations.update("all", {
        layout: { ...clauses[0]!.layout!, widthRem: 20 },
      }),
    );
    await settle();
    act(() => current.api.undo());
    expect(current.api.query.aggregations?.[0]?.layout?.widthRem).toBe(12);
    act(() => current.api.undo());
    expect(current.api.query.aggregations).toBeUndefined();
  });
  it("cancels obsolete work and excludes presentation and card order from requests", async () => {
    const pending: Array<{
      signal?: AbortSignal;
      resolve: (r: AggregationResult) => void;
    }> = [];
    const transport = v3Transport({
      answer: (request, signal) =>
        new Promise((resolve) =>
          pending.push({ ...(signal ? { signal } : {}), resolve: (r) => resolve(v3Response(request, r)) }),
        ),
    });
    const { current } = mount({
      schema,
      transport,
      debounceMs: 0,
      initialQuery: {
        ...EMPTY_QUERY,
        aggregations: [
          { id: "sum", op: "count", groupBy: [], expression: "SUM([x])" },
        ],
      },
    });
    await settle();
    expect(metricRequests(transport)).toHaveLength(1);
    act(() =>
      current.api.aggregations.update("sum", {
        label: "Renamed",
        display: {
          kind: "bar-horizontal",
          format: { kind: "duration", sourceUnit: "milliseconds" },
        },
        layout: { widthRem: 15, heightRem: 8, minWidthRem: 6, minHeightRem: 4 },
      }),
    );
    await settle();
    expect(metricRequests(transport)).toHaveLength(1);
    act(() => current.api.addFilter({ field: "x", op: ">", value: "15" }));
    await settle();
    expect(pending[0]!.signal!.aborted).toBe(true);
    expect(metricRequests(transport)).toHaveLength(2);
    await act(async () =>
      pending[0]!.resolve({
        metrics: [{ id: "sum", buckets: [{ keys: [], count: 3, value: 999 }] }],
      }),
    );
    expect(current.api.aggregations.results).toBeNull();
    await act(async () =>
      pending[1]!.resolve({
        metrics: [{ id: "sum", buckets: [{ keys: [], count: 2, value: 50 }] }],
      }),
    );
    expect(
      current.api.aggregations.results?.metrics[0]?.buckets[0]?.value,
    ).toBe(50);
  });
  it("invalidates metrics when the server plan token or snapshot changes", async () => {
    const transport = memoryV3Transport(rows, schema, { capabilities: { profile: "qt-pg-number-v1" } });
    const execution: ComputedExecution = {
      profile: "qt-pg-number-v1",
      planToken: "one",
      fields: {},
      resolvedRevisions: {},
    };
    const options: UseQueryTableOptions<Row> = {
      schema,
      transport,
      computedExecution: execution,
      debounceMs: 0,
      initialQuery: {
        ...EMPTY_QUERY,
        aggregations: [{ id: "count", op: "count", groupBy: [] }],
      },
    };
    const instance = mount(options);
    await settle();
    expect(metricRequests(transport)).toHaveLength(1);
    instance.rerender({
      ...options,
      computedExecution: { ...execution, planToken: "two", snapshot: "new" },
    });
    await settle();
    expect(metricRequests(transport)).toHaveLength(2);
    expect(metricRequests(transport)[1]!.planToken).toBe("two");
  });
  it("refreshes committed rows and metrics when only the requested snapshot changes", async () => {
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      fields: {},
      resolvedRevisions: {},
      snapshot: "s1",
    };
    const transport = memoryV3Transport(rows, schema, { capabilities: { profile: "qt-postgres-v1" } });
    const options: UseQueryTableOptions<Row> = {
      schema,
      transport,
      computedExecution: execution,
      debounceMs: 0,
      initialQuery: {
        ...EMPTY_QUERY,
        aggregations: [{ id: "count", op: "count", groupBy: [] }],
      },
    };
    const instance = mount(options);
    await settle();
    await settle();
    const calls = metricRequests(transport).length;
    instance.rerender({
      ...options,
      computedExecution: { ...execution, snapshot: "s2" },
    });
    await settle();
    await settle();
    expect(rowRequests(transport)).toHaveLength(2);
    expect(rowRequests(transport)[1]!.snapshot).toBe("s2");
    expect(metricRequests(transport).length).toBeGreaterThan(calls);
    expect(metricRequests(transport).at(-1)!.snapshot).toBe("s2");
    expect(instance.current.api.error).toBeNull();
  });
  it("rejects a response from a different snapshot", async () => {
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      fields: {},
      resolvedRevisions: {},
      snapshot: "s2",
    };
    const transport = v3Transport({
      profile: "qt-postgres-v1",
      serveRows: async (request) => {
        const result = serveQueryV3(rows, schema, request);
        return { ...result, execution: { ...result.execution, snapshot: "s1" } };
      },
    });
    const { current } = mount({
      schema,
      transport,
      computedExecution: execution,
      debounceMs: 0,
    });
    await settle();
    expect(current.api.rows).toEqual([]);
    expect(current.api.error?.message).toContain("mismatched query execution");
  });
  it("exposes authoritative computed grouping capabilities to the workbench", async () => {
    const store = memoryComputedColumnStore();
    const definition = await store.save(
      schema.name,
      {
        id: "category",
        label: "Category",
        expression: {
          language: "qt-expr",
          version: 1,
          source: 'IF([x] > 15, "high", "low")',
        },
      },
      null,
    );
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      fields: {
        "@computed/category": {
          type: "text",
          select: true,
          sort: true,
          measure: true,
          group: true,
        },
      },
      resolvedRevisions: { category: definition.revision },
    };
    const transport = v3Transport({
      profile: "qt-postgres-v1",
      answer: async (request) => v3Response(request, { metrics: [
        { id: "grouped", buckets: [{ keys: ["high"], count: 2, value: 2 }] },
      ] }),
    });
    const { current } = mount({
      schema,
      transport,
      computedExecution: execution,
      computedColumnStore: store,
      debounceMs: 0,
    });
    await settle();
    await settle();
    const field = current.api.computed.catalogue.find(
      (f) => f.name === "@computed/category",
    );
    expect(field?.aggregate?.groupable).toBe(true);
    const clause = {
      id: "grouped",
      op: "count" as const,
      groupBy: ["@computed/category"],
    };
    expect(() => current.api.aggregations.compile!(clause)).not.toThrow();
    const result = await current.api.aggregations.preview!([clause]);
    expect(result.metrics[0]?.buckets[0]?.keys).toEqual(["high"]);
    expect(metricRequests(transport).at(-1)!.expectedRevisions).toEqual({
      category: definition.revision,
    });
  });
  it("suppresses server computed values while a different execution snapshot is pending", async () => {
    const store = memoryComputedColumnStore();
    const definition = await store.save(
      schema.name,
      {
        id: "double",
        label: "Double",
        expression: { language: "qt-expr", version: 1, source: "[x] * 2" },
      },
      null,
    );
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      snapshot: "s1",
      fields: {
        "@computed/double": {
          type: "number",
          select: true,
          sort: true,
          measure: true,
          group: false,
        },
      },
      resolvedRevisions: { double: definition.revision },
    };
    const transport = v3Transport({
      profile: "qt-postgres-v1",
      serveRows: async (request) => {
        if (request.snapshot === "s2") return new Promise(() => {});
        return computedPage(request, [{ ...rows[0]!, "@computed/double": 20 }], 3);
      },
    });
    const options: UseQueryTableOptions<Row> = {
      schema,
      transport,
      computedExecution: execution,
      computedColumnStore: store,
      debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, select: [{ field: "@computed/double" }] },
    };
    const instance = mount(options);
    await settle();
    await settle();
    expect(
      readFieldValue(
        instance.current.api.visibleFields[0]!,
        instance.current.api.rows[0]!,
      ),
    ).toBe(20);
    instance.rerender({
      ...options,
      computedExecution: { ...execution, snapshot: "s2" },
    });
    await settle();
    expect(
      readFieldValue(
        instance.current.api.visibleFields[0]!,
        instance.current.api.rows[0]!,
      ),
    ).toEqual(
      expect.objectContaining({
        computedError: expect.stringContaining("pending"),
      }),
    );
  });
  it("attaches server values by stable identity and rejects values from an obsolete definition", async () => {
    const store = memoryComputedColumnStore();
    const draft = {
      id: "double",
      label: "Double",
      expression: {
        language: "qt-expr" as const,
        version: 1 as const,
        source: "[x] * 2",
      },
    };
    const definition = await store.save(schema.name, draft, null);
    const execution: ComputedExecution = {
      profile: "qt-pg-number-v1",
      planToken: "one",
      fields: {
        "@computed/double": {
          type: "number",
          select: true,
          sort: true,
          measure: true,
          group: false,
        },
      },
      resolvedRevisions: { double: definition.revision },
    };
    const transport = v3Transport({
      profile: "qt-pg-number-v1",
      serveRows: async (request) => computedPage(request,
        [{ ...rows[1]!, "@computed/double": 40 }, { ...rows[0]!, "@computed/double": 20 }], 3),
    });
    const options: UseQueryTableOptions<Row> = {
      schema,
      transport,
      computedExecution: execution,
      computedColumnStore: store,
      debounceMs: 0,
      initialQuery: {
        ...EMPTY_QUERY,
        select: [{ field: "@computed/double" }],
        orderBy: [{ field: "@computed/double", dir: "desc" }],
      },
    };
    const { current } = mount(options);
    await settle();
    await settle();
    expect(
      current.api.rows.map((row) => readFieldValue(current.api.visibleFields[0]!, row)),
    ).toEqual([40, 20]);
    expect(rowRequests(transport)[0]!.result.orderBy).toEqual([{ field: "@computed/double", dir: "desc" }]);
    await act(async () => {
      await store.save(
        schema.name,
        {
          ...draft,
          label: "Triple",
          expression: { ...draft.expression, source: "[x] * 3" },
        },
        definition.revision,
      );
    });
    await settle();
    expect(current.api.error?.message).toContain("handshake");
    expect(current.api.rows).toEqual([]);
  });
  it("refreshes a computed row through the page pipeline", async () => {
    const store = memoryComputedColumnStore();
    const definition = await store.save(
      schema.name,
      {
        id: "double",
        label: "Double",
        expression: { language: "qt-expr", version: 1, source: "[x] * 2" },
      },
      null,
    );
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "test-plan",
      fields: {
        "@computed/double": {
          type: "number",
          select: true,
          sort: true,
          measure: true,
          group: false,
        },
      },
      resolvedRevisions: { double: definition.revision },
    };
    let x = 10;
    let release!: () => void;
    const transport = v3Transport({
      profile: "qt-postgres-v1",
      serveRows: async (request) => {
        if (x === 50)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return computedPage(request, [{ id: 1, x, group: "a", "@computed/double": x * 2 }]);
      },
    });
    const { current } = mount({
      schema,
      transport,
      computedExecution: execution,
      computedColumnStore: store,
      initialQuery: { ...EMPTY_QUERY, select: [{ field: "@computed/double" }] },
      debounceMs: 0,
    });
    await settle();
    await settle();
    const value = () =>
      readFieldValue(current.api.visibleFields[0]!, current.api.rows[0]!);
    expect(value()).toBe(20);
    const calls = rowRequests(transport).length;
    x = 50;
    await act(async () => current.api.refreshRow(1));
    await settle();
    expect(rowRequests(transport)).toHaveLength(calls + 1);
    expect(rowRequests(transport).at(-1)!.result.limit).toBe(EMPTY_QUERY.limit);
    expect(current.api.loading).toBe(true);
    expect(current.api.rows[0]!.x).toBe(10);
    expect(value()).toBe(20);
    await act(async () => release());
    expect(current.api.loading).toBe(false);
    expect(current.api.rows[0]!.x).toBe(50);
    expect(value()).toBe(100);
  });
  it("refreshes a single row in place through a v3 identity lookup", async () => {
    let current_rows = [rows[0]!];
    const transport = memoryV3Transport(() => current_rows, schema);
    const { current } = mount({
      schema,
      transport,
      debounceMs: 0,
    });
    await settle();
    current_rows = [{ ...rows[0]!, x: 50 }];
    await act(async () => current.api.refreshRow(1));
    expect(current.api.rows[0]!.x).toBe(50);
    const [page, lookup] = rowRequests(transport);
    expect(rowRequests(transport)).toHaveLength(2);
    expect(page!.result.limit).toBe(EMPTY_QUERY.limit);
    expect(lookup!.result).toMatchObject({ where: [{ field: "id", op: "=", value: "1" }], limit: 2, offset: 0 });
    expect(lookup!.result.select).toEqual(page!.result.select);
  });
});

it("keeps server-scoped metrics in flight when the table page arrives", async () => {
  let resolveRows!: () => void;
  const pending: AbortSignal[] = [];
  const transport = v3Transport({
    serveRows: (request) =>
      new Promise((resolve) => {
        resolveRows = () => resolve(serveQueryV3(rows, schema, request));
      }),
    answer: (_request, signal) => {
      pending.push(signal!);
      return new Promise(() => {});
    },
  });
  const { current } = mount({
    schema,
    transport,
    debounceMs: 0,
    initialQuery: {
      ...EMPTY_QUERY,
      limit: 1,
      aggregations: [
        { id: "all", op: "count", groupBy: [], scope: "allMatching" },
        { id: "page", op: "count", groupBy: [], scope: "shownRows" },
      ],
    },
  });
  await settle();
  expect(metricRequests(transport)).toHaveLength(1);
  await act(async () => resolveRows());
  await settle();
  expect(metricRequests(transport)).toHaveLength(1);
  expect(pending[0]!.aborted).toBe(false);
  act(() => current.api.setQuery({ ...current.api.query, offset: 1 }));
  await settle();
  expect(pending[0]!.aborted).toBe(true);
  expect(metricRequests(transport)).toHaveLength(2);
  expect(metricRequests(transport)[1]!.result.offset).toBe(1);
});

describe("independent metric transport", () => {
  const clientRows = rows.map((row, i) => ({ ...row, x: [2, 3, 7][i]! }));
  const all = { id: "all", op: "count" as const, groupBy: [], scope: "allMatching" as const };
  const shown = { id: "shown", op: "sum" as const, field: "x", groupBy: [], scope: "shownRows" as const };
  function metrics(profile?: string) {
    const metricTransport = v3Transport({
      ...(profile ? { profile } : {}),
      serveRows: async () => { throw Error("Metric transport must not fetch rows"); },
      answer: async (request) => v3Response(request, { metrics: request.metrics.map(m => ({ id: m.id, buckets: [{ keys: [], value: 100, count: 100 }] })) }),
    });
    return { metricTransport };
  }
  async function ready() { await settle(); await settle(); }
  const values = (api: QueryTableApi<Row>) => api.aggregations.results?.metrics.map(m => m.buckets[0]?.value);

  it("fetches remote allMatching without switching client row paging or waiting for the external page", async () => {
    const remote = metrics();
    const { current } = mount({ schema, clientRows, ...remote, debounceMs: 0,
      metricRowsReady: () => false,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [all] },
    });
    await ready();
    expect(current.api.rows.map(r => r.x)).toEqual([2, 3]);
    expect(values(current.api)).toEqual([100]);
    expect(metricRequests(remote.metricTransport)).toHaveLength(1);
    expect(rowRequests(remote.metricTransport)).toEqual([]);
    expect(current.api.requestActivity.entries).toMatchObject([{ kind: "Metrics", status: "success" }]);
  });

  it("sends shown-row and remote counts in one request with the current filter, sort and window", async () => {
    const remote = metrics();
    const { current } = mount({ schema, clientRows, ...remote, debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, limit: 2, offset: 1, aggregations: [shown, all] },
    });
    await ready();
    expect(current.api.rows.map(r => r.x)).toEqual([3, 7]);
    expect(values(current.api)).toEqual([100, 100]);
    expect(current.api.aggregations.results?.metrics.map(m => m.id)).toEqual(["shown", "all"]);
    expect(metricRequests(remote.metricTransport)).toHaveLength(1);
    expect(metricRequests(remote.metricTransport)[0]!).toMatchObject({ rows: false, result: { limit: 2, offset: 1 } });
    expect(metricRequests(remote.metricTransport)[0]!.metrics.map(m => m.id)).toEqual(["shown", "all"]);
    act(() => current.api.setQuery(q => ({ ...q, offset: 0,
      where: [{ field: "x", op: ">", value: "2" }], orderBy: [{ field: "x", dir: "desc" }], limit: 1 })));
    await ready();
    expect(current.api.rows.map(r => r.x)).toEqual([7]);
    expect(metricRequests(remote.metricTransport).at(-1)!.result).toMatchObject({ where: [{ field: "x", op: ">", value: "2" }],
      orderBy: [{ field: "x", dir: "desc" }], limit: 1, offset: 0 });
    expect(rowRequests(remote.metricTransport)).toEqual([]);
  });

  it("blocks local previews while external readiness is false and clears results when readiness is lost", async () => {
    let externalReady = false;
    const metricRowsReady = vi.fn(() => externalReady);
    const options: UseQueryTableOptions<Row> = { schema, clientRows, debounceMs: 0, metricRowsReady,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [all, shown] },
    };
    const { current, rerender } = mount(options);
    await ready();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    expect(current.api.aggregations.results).toBeNull();
    expect(current.api.aggregations.loading).toBe(true);
    const unavailableKey = current.api.aggregations.contextKey;
    externalReady = true; rerender(options); await ready();
    expect(values(current.api)).toEqual([3, 5]);
    expect((await current.api.aggregations.preview!([shown])).metrics[0]?.buckets[0]?.value).toBe(5);
    expect(current.api.aggregations.contextKey).not.toBe(unavailableKey);
    externalReady = false; rerender(options);
    expect(current.api.aggregations.results).toBeNull();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    expect(metricRowsReady).toHaveBeenLastCalledWith(current.api.query);
  });

  it("honors the external gate in a purely local table", async () => {
    const { current } = mount({ schema, clientRows, debounceMs: 0, metricRowsReady: () => false,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [shown] },
    });
    await ready();
    expect(current.api.aggregations.results).toBeNull();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
  });

  it("uses metricExecution independently and refreshes the metric handshake without fetching rows", async () => {
    const remote = metrics("qt-postgres-v1");
    const rowExecution: ComputedExecution = { profile: "qt-postgres-v1", planToken: "row-plan", fields: {}, resolvedRevisions: {} };
    const metricExecution: ComputedExecution = { ...rowExecution, planToken: "metric-plan", resolvedRevisions: { double: "metric-r1" },
      fields: { "@computed/double": { type: "number", select: true, sort: true, measure: true, group: true } },
    };
    const options: UseQueryTableOptions<Row> = { schema, clientRows, ...remote,
      computedExecution: rowExecution, metricExecution, debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, aggregations: [{ ...all, field: "@computed/double", op: "sum" }] },
    };
    const { current, rerender } = mount(options); await ready();
    expect(current.api.error).toBeNull();
    expect(current.api.aggregations.error).toBeNull();
    expect(metricRequests(remote.metricTransport)[0]!).toMatchObject({ planToken: "metric-plan", expectedRevisions: { double: "metric-r1" } });
    expect(() => current.api.aggregations.compile!({ ...all, field: "@computed/double", op: "sum", groupBy: ["@computed/double"] })).not.toThrow();
    const contextKey = current.api.aggregations.contextKey;
    rerender({ ...options, metricExecution: { ...metricExecution, planToken: "metric-plan-2", resolvedRevisions: { double: "metric-r2" } } });
    await ready();
    expect(metricRequests(remote.metricTransport)[1]!).toMatchObject({ planToken: "metric-plan-2", expectedRevisions: { double: "metric-r2" } });
    expect(current.api.aggregations.contextKey).not.toBe(contextKey);
    expect(rowRequests(remote.metricTransport)).toEqual([]);
  });

  it("exposes metric grouping authority in the editor catalogue while retaining row capabilities", async () => {
    const store = memoryComputedColumnStore();
    const definition = await store.save(schema.name, {
      id: "category", label: "Category",
      expression: { language: "qt-expr", version: 1, source: "[group]" },
    }, null);
    const remote = metrics("qt-postgres-v1");
    const metricExecution: ComputedExecution = {
      profile: "qt-postgres-v1", planToken: "metric-plan",
      resolvedRevisions: { category: definition.revision },
      fields: { "@computed/category": { type: "text", select: true, sort: true, group: true, measure: true, filter: true } },
    };
    const options: UseQueryTableOptions<Row> = {
      schema, clientRows, metricTransport: remote.metricTransport, metricExecution,
      computedColumnStore: store, debounceMs: 0, initialQuery: { ...EMPTY_QUERY },
    };
    const { current, rerender } = mount(options); await ready();
    const field = () => current.api.computed.catalogue.find(f => f.name === "@computed/category")!;
    // MetricsEditor builds its Group by choices using this same predicate.
    expect(current.api.computed.catalogue.filter(isGroupable).map(f => f.name)).toContain("@computed/category");
    expect(field().sort?.enabled).toBe(false);
    expect(field().filter?.enabled).toBe(false);
    expect(field().source.kind).toBe("derived");
    const grouped = { ...all, groupBy: ["@computed/category"] };
    expect(() => current.api.aggregations.compile!(grouped)).not.toThrow();

    rerender({ ...options, metricExecution: { ...metricExecution,
      fields: { "@computed/category": { ...metricExecution.fields["@computed/category"]!, group: false } },
    } }); await ready();
    expect(isGroupable(field())).toBe(false);
    expect(() => current.api.aggregations.compile!(grouped)).toThrow("cannot group");

    rerender({ ...options, metricExecution: { ...metricExecution, resolvedRevisions: { category: "stale" } } });
    await ready();
    expect(isGroupable(field())).toBe(false);
    expect(() => current.api.aggregations.compile!(grouped)).toThrow("cannot group");
    expect(rowRequests(remote.metricTransport)).toEqual([]);
  });

  it("waits for query restoration before using the independent metric transport", async () => {
    const remote = metrics();
    const storage = memoryStorageAdapter();
    let restore!: (query: typeof EMPTY_QUERY) => void;
    storage.loadLast = () => new Promise(resolve => { restore = resolve; });
    const { current } = mount({ schema, clientRows, ...remote, storage, debounceMs: 0 });
    await ready();
    expect(remote.metricTransport.fetchQueryV3).not.toHaveBeenCalled();
    await act(async () => restore({ ...EMPTY_QUERY, aggregations: [all] }));
    await ready();
    expect(current.api.restoration.ready).toBe(true);
    expect(values(current.api)).toEqual([100]);
  });

  it.each(["readiness", "rows", "query"])("cancels local workers and previews when %s changes", async change => {
    const terminate = vi.fn();
    const workerFactory = vi.fn(() => ({ terminate, postMessage: vi.fn(), onmessage: null, onerror: null }) as unknown as Worker);
    const regex = { ...shown, expression: 'SUM(IF(REGEX_TEST([group], "a"), 1, 0))' };
    const options: UseQueryTableOptions<Row> = { schema, clientRows, debounceMs: 0, formulaWorkerFactory: workerFactory,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [all, regex] },
    };
    const { current, rerender } = mount(options); await ready();
    expect(workerFactory).toHaveBeenCalledOnce();
    const preview = current.api.aggregations.preview!([regex]).then(() => "unexpected success", (e: Error) => e.name);
    expect(workerFactory).toHaveBeenCalledTimes(2);
    if (change === "readiness") rerender({ ...options, metricRowsReady: () => false });
    else if (change === "rows") rerender({ ...options, clientRows: clientRows.map(r => ({ ...r, x: 99 })) });
    else act(() => current.api.setOffset(1));
    expect(await preview).toBe("AbortError");
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(current.api.aggregations.results).toBeNull();
  });

  it("uses a separate V3 metric executor and handshake while keeping client rows", async () => {
    const datedSchema: FieldSchema<Row> = { ...schema, fields: [...schema.fields,
      { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } },
    ] };
    const metricExecution: ComputedExecution = { profile: "qt-sqlite-v1", planToken: "v3-metric-plan", resolvedRevisions: {}, fields: {} };
    const fetchQueryV3 = vi.fn(async (request: QueryRequestV3): Promise<QueryResultV3> => ({
      version: 3, now: request.now, rows: [], total: 100, sourceTotal: 100,
      schema: { name: datedSchema.name, idField: "id", fields: datedSchema.fields.map(({ name, type }) => ({ name, type })) },
      execution: metricExecution,
      metrics: request.metrics.map(m => ({ id: m.id, buckets: [{ keys: [], value: 100, count: 100 }] })),
    }));
    const metricTransport: Transport<Row> = { fetchQueryV3,
      queryCapabilities: { version: 3, profile: metricExecution.profile, calendarGrouping: true,
        groupedRows: true, computedSourceFilters: true, regex: false, maxRows: 10000, maxGroups: 2000, maxPopulation: 250000 },
    };
    const { current } = mount({ schema: datedSchema, clientRows, metricTransport, metricExecution, debounceMs: 0,
      metricRowsReady: () => false,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [
        { ...all, groupBy: ["at"], dateGrouping: { field: "at", interval: "day", includeEmpty: false, range: "observed" } }, shown,
      ] },
    });
    await ready();
    expect(current.api.aggregations.error).toBeNull();
    expect(values(current.api)).toEqual([100, 100]);
    expect(current.api.rows.map(r => r.x)).toEqual([2, 3]);
    expect(fetchQueryV3).toHaveBeenCalledOnce();
    expect(fetchQueryV3.mock.calls[0]![0]).toMatchObject({ rows: false, planToken: "v3-metric-plan" });
    expect(current.api.requestActivity.entries).toMatchObject([{ kind: "Metrics", status: "success" }]);
  });
});
