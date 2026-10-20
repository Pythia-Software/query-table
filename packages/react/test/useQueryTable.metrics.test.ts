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
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});
describe("transactional metrics controller", () => {
  it("still reports query validation failures while a shown-row page is unavailable", async () => {
    const fetchRows = vi.fn(async () => ({ rows, total: 3 }));
    const { current } = mount({
      schema,
      transport: { fetchRows },
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
    expect(fetchRows).not.toHaveBeenCalled();
  });
  it("waits without error for legacy shown-row metrics on initial load, page changes, and refresh", async () => {
    const pending: Array<(value: { rows: Row[]; total: number }) => void> = [];
    const fetchRows = vi.fn(
      () =>
        new Promise<{ rows: Row[]; total: number }>((resolve) =>
          pending.push(resolve),
        ),
    );
    const { current } = mount({
      schema,
      transport: { fetchRows },
      debounceMs: 0,
      initialQuery: {
        ...EMPTY_QUERY,
        limit: 1,
        aggregations: [
          {
            id: "shown",
            op: "sum",
            field: "x",
            groupBy: [],
            scope: "shownRows",
          },
        ],
      },
    });
    for (let page = 0; page < 3; page++) {
      await settle();
      expect(current.api.aggregations.error).toBeNull();
      expect(current.api.aggregations.loading).toBe(true);
      expect(current.api.aggregations.results).toBeNull();
      await act(async () => pending[page]!({ rows: [rows[page]!], total: 3 }));
      await settle();
      expect(current.api.aggregations.error).toBeNull();
      expect(current.api.aggregations.loading).toBe(false);
      expect(
        current.api.aggregations.results?.metrics[0]?.buckets[0]?.value,
      ).toBe(rows[page]!.x);
      if (page === 0) act(() => current.api.setOffset(1));
      if (page === 1) act(() => current.api.refresh());
    }
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
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      (_q, signal) =>
        new Promise((resolve) =>
          pending.push({ ...(signal ? { signal } : {}), resolve }),
        ),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchMetrics,
      metricCapabilities: { version: 2, expressions: true },
    };
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
    expect(fetchMetrics).toHaveBeenCalledOnce();
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
    expect(fetchMetrics).toHaveBeenCalledOnce();
    act(() => current.api.addFilter({ field: "x", op: ">", value: "15" }));
    await settle();
    expect(pending[0]!.signal!.aborted).toBe(true);
    expect(fetchMetrics).toHaveBeenCalledTimes(2);
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
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({ metrics: [{ id: "count", buckets: [] }] }),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchMetrics,
      metricCapabilities: { version: 2 },
    };
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
    expect(fetchMetrics).toHaveBeenCalledOnce();
    instance.rerender({
      ...options,
      computedExecution: { ...execution, planToken: "two", snapshot: "new" },
    });
    await settle();
    expect(fetchMetrics).toHaveBeenCalledTimes(2);
    expect(fetchMetrics.mock.calls[1]![0].planToken).toBe("two");
  });
  it("refreshes v2 committed rows and metrics when only the requested snapshot changes", async () => {
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      fields: {},
      resolvedRevisions: {},
      snapshot: "s1",
    };
    const fetchRowsV2 = vi.fn<NonNullable<Transport<Row>["fetchRowsV2"]>>(
      async (request) => ({
        version: 2,
        rows,
        total: 3,
        computed: [],
        execution: { ...execution, snapshot: request.snapshot! },
      }),
    );
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({ metrics: [{ id: "count", buckets: [] }] }),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchRowsV2,
      fetchMetrics,
      metricCapabilities: { version: 2 },
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
    await settle();
    const calls = fetchMetrics.mock.calls.length;
    instance.rerender({
      ...options,
      computedExecution: { ...execution, snapshot: "s2" },
    });
    await settle();
    await settle();
    expect(fetchRowsV2).toHaveBeenCalledTimes(2);
    expect(fetchRowsV2.mock.calls[1]![0].snapshot).toBe("s2");
    expect(fetchMetrics.mock.calls.length).toBeGreaterThan(calls);
    expect(fetchMetrics.mock.lastCall![0].snapshot).toBe("s2");
    expect(instance.current.api.error).toBeNull();
  });
  it("rejects a v2 response from a different snapshot", async () => {
    const execution: ComputedExecution = {
      profile: "qt-postgres-v1",
      planToken: "same",
      fields: {},
      resolvedRevisions: {},
      snapshot: "s2",
    };
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchRowsV2: async () => ({
        version: 2,
        rows,
        total: 3,
        computed: [],
        execution: { ...execution, snapshot: "s1" },
      }),
    };
    const { current } = mount({
      schema,
      transport,
      computedExecution: execution,
      debounceMs: 0,
    });
    await settle();
    expect(current.api.rows).toEqual([]);
    expect(current.api.error?.message).toContain("execution identity");
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
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
      async () => ({
        metrics: [
          { id: "grouped", buckets: [{ keys: ["high"], count: 2, value: 2 }] },
        ],
      }),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchMetrics,
      metricCapabilities: {
        version: 2,
        expressions: true,
        computedFields: true,
      },
    };
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
    expect(fetchMetrics.mock.lastCall![0].expectedRevisions).toEqual({
      category: definition.revision,
    });
  });
  it("suppresses sidecars while a different execution snapshot is pending", async () => {
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
    const fetchRowsV2 = vi.fn<NonNullable<Transport<Row>["fetchRowsV2"]>>(
      async (request) => {
        if (request.snapshot === "s2") return new Promise(() => {});
        return {
          version: 2,
          rows: [rows[0]!],
          total: 3,
          computed: [{ id: 1, values: { double: { value: 20 } } }],
          execution,
        };
      },
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchRowsV2,
    };
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
    const fetchRowsV2 = vi.fn<NonNullable<Transport<Row>["fetchRowsV2"]>>(
      async () => ({
        version: 2,
        rows: [rows[1]!, rows[0]!],
        total: 3,
        computed: [
          { id: 1, values: { double: { value: 20 } } },
          { id: 2, values: { double: { value: 40 } } },
        ],
        execution,
      }),
    );
    const transport: Transport<Row> = {
      fetchRows: async () => ({ rows, total: 3 }),
      fetchRowsV2,
    };
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
      readFieldValue(current.api.visibleFields[0]!, current.api.rows[0]!),
    ).toBe(40);
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
  it("refreshes a V2 row and its sidecar together through the page pipeline", async () => {
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
    const fetchRowsV2 = vi.fn<NonNullable<Transport<Row>["fetchRowsV2"]>>(
      async () => {
        if (x === 50)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          version: 2,
          rows: [{ id: 1, x, group: "a" }],
          total: 1,
          computed: [{ id: 1, values: { double: { value: x * 2 } } }],
          execution,
        };
      },
    );
    const fetchRow = vi.fn(async () => ({ id: 1, x, group: "a" }));
    const { current } = mount({
      schema,
      transport: {
        fetchRows: async () => ({ rows: [], total: 0 }),
        fetchRowsV2,
        fetchRow,
      },
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
    const calls = fetchRowsV2.mock.calls.length;
    x = 50;
    await act(async () => current.api.refreshRow(1));
    await settle();
    expect(fetchRow).not.toHaveBeenCalled();
    expect(fetchRowsV2).toHaveBeenCalledTimes(calls + 1);
    expect(current.api.loading).toBe(true);
    expect(current.api.rows[0]!.x).toBe(10);
    expect(value()).toBe(20);
    await act(async () => release());
    expect(current.api.loading).toBe(false);
    expect(current.api.rows[0]!.x).toBe(50);
    expect(value()).toBe(100);
  });
  it("retains the single-row refresh path for legacy transports", async () => {
    const fetchRows = vi.fn(async () => ({ rows: [rows[0]!], total: 1 }));
    const fetchRow = vi.fn(async () => ({ ...rows[0]!, x: 50 }));
    const { current } = mount({
      schema,
      transport: { fetchRows, fetchRow },
      debounceMs: 0,
    });
    await settle();
    await act(async () => current.api.refreshRow(1));
    expect(current.api.rows[0]!.x).toBe(50);
    expect(fetchRows).toHaveBeenCalledOnce();
    expect(fetchRow).toHaveBeenCalledWith(1);
  });
});

it("keeps server-scoped metrics in flight when the table page arrives", async () => {
  let resolveRows!: (value: { rows: Row[]; total: number }) => void;
  const pending: AbortSignal[] = [];
  const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(
    (_query, signal) => {
      pending.push(signal!);
      return new Promise(() => {});
    },
  );
  const transport: Transport<Row> = {
    fetchRows: () =>
      new Promise((resolve) => {
        resolveRows = resolve;
      }),
    fetchMetrics,
    metricCapabilities: { version: 2, shownRows: true },
  };
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
  expect(fetchMetrics).toHaveBeenCalledOnce();
  await act(async () =>
    resolveRows({ rows: rows.slice(0, 1), total: rows.length }),
  );
  await settle();
  expect(fetchMetrics).toHaveBeenCalledOnce();
  expect(pending[0]!.aborted).toBe(false);
  act(() => current.api.setQuery({ ...current.api.query, offset: 1 }));
  await settle();
  expect(pending[0]!.aborted).toBe(true);
  expect(fetchMetrics).toHaveBeenCalledTimes(2);
});

it("surfaces failed shown-page fetches and recovers on refresh", async () => {
  const failure = Error("Rows unavailable");
  const fetchRows = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ rows, total: 3 });
  const { current } = mount({
    schema,
    transport: { fetchRows },
    debounceMs: 0,
    initialQuery: {
      ...EMPTY_QUERY,
      aggregations: [
        { id: "shown", op: "count", scope: "shownRows", groupBy: [] },
      ],
    },
  });
  await settle();
  expect(current.api.aggregations.loading).toBe(false);
  expect(current.api.aggregations.error?.message).toBe("Rows unavailable");
  act(() => current.api.refresh());
  await settle();
  await settle();
  expect(current.api.aggregations.error).toBeNull();
  expect(current.api.aggregations.results?.metrics[0]?.buckets[0]?.value).toBe(
    3,
  );
});

describe("independent metric transport", () => {
  const clientRows = rows.map((row, i) => ({ ...row, x: [2, 3, 7][i]! }));
  const all = { id: "all", op: "count" as const, groupBy: [], scope: "allMatching" as const };
  const shown = { id: "shown", op: "sum" as const, field: "x", groupBy: [], scope: "shownRows" as const };
  function metrics() {
    const fetchRows = vi.fn(async (): Promise<{ rows: Row[]; total: number }> => { throw Error("Metric transport must not fetch rows"); });
    const fetchMetrics = vi.fn<NonNullable<Transport<Row>["fetchMetrics"]>>(async request => ({
      metrics: request.metrics.map(m => ({ id: m.id, buckets: [{ keys: [], value: 100, count: 100 }] })),
    }));
    const metricTransport: Transport<Row> = { fetchRows, fetchMetrics, metricCapabilities: { version: 2, expressions: true, distributions: true, shownRows: false } };
    return { metricTransport, fetchRows, fetchMetrics };
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
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
    expect(remote.fetchRows).not.toHaveBeenCalled();
    expect(current.api.requestActivity.entries).toMatchObject([{ kind: "Metrics", status: "success" }]);
  });

  it("combines remote count and the committed page after filtering, sorting, offset and limit", async () => {
    const remote = metrics();
    const { current } = mount({ schema, clientRows, ...remote, debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, limit: 2, offset: 1, aggregations: [shown, all] },
    });
    await ready();
    expect(current.api.rows.map(r => r.x)).toEqual([3, 7]);
    expect(values(current.api)).toEqual([10, 100]);
    expect(current.api.aggregations.results?.metrics.map(m => m.id)).toEqual(["shown", "all"]);
    expect(remote.fetchMetrics.mock.calls[0]![0].metrics.map(m => m.id)).toEqual(["all"]);
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
    act(() => current.api.setQuery(q => ({ ...q, offset: 0,
      where: [{ field: "x", op: ">", value: "2" }], orderBy: [{ field: "x", dir: "desc" }], limit: 1 })));
    await ready();
    expect(current.api.rows.map(r => r.x)).toEqual([7]);
    expect(values(current.api)).toEqual([7, 100]);
    expect(remote.fetchRows).not.toHaveBeenCalled();
  });

  it("blocks previews while external readiness is false and clears results when readiness is lost", async () => {
    const remote = metrics();
    let externalReady = false;
    const metricRowsReady = vi.fn(() => externalReady);
    const options: UseQueryTableOptions<Row> = { schema, clientRows, ...remote, debounceMs: 0, metricRowsReady,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [all, shown] },
    };
    const { current, rerender } = mount(options);
    await ready();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
    expect(current.api.aggregations.results).toBeNull();
    expect(current.api.aggregations.loading).toBe(true);
    const unavailableKey = current.api.aggregations.contextKey;
    externalReady = true; rerender(options); await ready();
    expect(values(current.api)).toEqual([100, 5]);
    expect((await current.api.aggregations.preview!([shown])).metrics[0]?.buckets[0]?.value).toBe(5);
    expect(current.api.aggregations.contextKey).not.toBe(unavailableKey);
    externalReady = false; rerender(options);
    expect(current.api.aggregations.results).toBeNull();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
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

  it.each([false, undefined])("waits for committed server rows with V2 shownRows=%s without metric overrides", async shownRows => {
    const remote = metrics();
    let commit!: (result: { rows: Row[]; total: number }) => void;
    const fetchRows = vi.fn(() => new Promise<{ rows: Row[]; total: number }>(resolve => { commit = resolve; }));
    const transport: Transport<Row> = { ...remote.metricTransport, fetchRows,
      metricCapabilities: { version: 2, ...(shownRows !== undefined ? { shownRows } : {}) },
    };
    const { current } = mount({ schema, transport, debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [shown, all] },
    });
    await ready();
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
    expect(current.api.aggregations.loading).toBe(true);
    expect(current.api.aggregations.results).toBeNull();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    await act(async () => commit({ rows: clientRows.slice(0, 2), total: 100 }));
    await ready();
    expect(values(current.api)).toEqual([5, 100]);
    expect(fetchRows).toHaveBeenCalledOnce();
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
    expect(current.api.requestActivity.entries.map(e => e.kind).sort()).toEqual(["Metrics", "Rows"]);
  });

  it("keeps the remote batch in flight through readiness, origin, and page changes", async () => {
    const remote = metrics();
    let finish!: (result: AggregationResult) => void;
    remote.fetchMetrics.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let availableQuery = "old";
    const options: UseQueryTableOptions<Row> = { schema, clientRows, ...remote, debounceMs: 0,
      metricRowsReady: q => availableQuery === `${q.offset}:${q.limit}`,
      initialQuery: { ...EMPTY_QUERY, limit: 2, aggregations: [all, shown] },
    };
    const { current, rerender } = mount(options);
    await ready();
    const remoteSignal = remote.fetchMetrics.mock.calls[0]![1]!;
    availableQuery = "0:2"; rerender(options); await ready();
    act(() => current.api.setOffset(1));
    expect(current.api.aggregations.results).toBeNull();
    await ready();
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    availableQuery = "1:2";
    const changedRows = clientRows.map(r => ({ ...r, x: r.x * 10 }));
    rerender({ ...options, clientRows: changedRows });
    await expect(current.api.aggregations.preview!([shown])).rejects.toThrow("current table page");
    await ready();
    await act(async () => finish({ metrics: [{ id: "all", buckets: [{ keys: [], value: 100, count: 100 }] }] }));
    expect(values(current.api)).toEqual([100, 100]);
    expect(remoteSignal.aborted).toBe(false);
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
  });

  it("uses metricExecution independently and refreshes the metric handshake without fetching rows", async () => {
    const remote = metrics();
    const rowExecution: ComputedExecution = { profile: "qt-postgres-v1", planToken: "row-plan", fields: {}, resolvedRevisions: {} };
    const metricExecution: ComputedExecution = { ...rowExecution, planToken: "metric-plan", resolvedRevisions: { double: "metric-r1" },
      fields: { "@computed/double": { type: "number", select: true, sort: true, measure: true, group: true } },
    };
    remote.metricTransport.metricCapabilities = { version: 2, computedFields: true, expressions: true };
    const options: UseQueryTableOptions<Row> = { schema, clientRows, ...remote,
      computedExecution: rowExecution, metricExecution, debounceMs: 0,
      initialQuery: { ...EMPTY_QUERY, aggregations: [{ ...all, field: "@computed/double", op: "sum" }] },
    };
    const { current, rerender } = mount(options); await ready();
    expect(current.api.error).toBeNull();
    expect(current.api.aggregations.error).toBeNull();
    expect(remote.fetchMetrics.mock.calls[0]![0]).toMatchObject({ planToken: "metric-plan", expectedRevisions: { double: "metric-r1" } });
    expect(() => current.api.aggregations.compile!({ ...all, field: "@computed/double", op: "sum", groupBy: ["@computed/double"] })).not.toThrow();
    const contextKey = current.api.aggregations.contextKey;
    rerender({ ...options, metricExecution: { ...metricExecution, planToken: "metric-plan-2", resolvedRevisions: { double: "metric-r2" } } });
    await ready();
    expect(remote.fetchMetrics.mock.calls[1]![0]).toMatchObject({ planToken: "metric-plan-2", expectedRevisions: { double: "metric-r2" } });
    expect(current.api.aggregations.contextKey).not.toBe(contextKey);
    expect(remote.fetchRows).not.toHaveBeenCalled();
  });

  it("exposes metric grouping authority in the editor catalogue while retaining row capabilities", async () => {
    const store = memoryComputedColumnStore();
    const definition = await store.save(schema.name, {
      id: "category", label: "Category",
      expression: { language: "qt-expr", version: 1, source: "[group]" },
    }, null);
    const remote = metrics();
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
    expect(remote.fetchRows).not.toHaveBeenCalled();
  });

  it("waits for query restoration before using the independent metric transport", async () => {
    const remote = metrics();
    const storage = memoryStorageAdapter();
    let restore!: (query: typeof EMPTY_QUERY) => void;
    storage.loadLast = () => new Promise(resolve => { restore = resolve; });
    const { current } = mount({ schema, clientRows, ...remote, storage, debounceMs: 0 });
    await ready();
    expect(remote.fetchMetrics).not.toHaveBeenCalled();
    await act(async () => restore({ ...EMPTY_QUERY, aggregations: [all] }));
    await ready();
    expect(current.api.restoration.ready).toBe(true);
    expect(values(current.api)).toEqual([100]);
  });

  it.each(["readiness", "rows", "query"])("cancels local workers and previews when %s changes", async change => {
    const terminate = vi.fn();
    const workerFactory = vi.fn(() => ({ terminate, postMessage: vi.fn(), onmessage: null, onerror: null }) as unknown as Worker);
    const remote = metrics();
    const regex = { ...shown, expression: 'SUM(IF(REGEX_TEST([group], "a"), 1, 0))' };
    const options: UseQueryTableOptions<Row> = { schema, clientRows, ...remote, debounceMs: 0, formulaWorkerFactory: workerFactory,
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
    expect(remote.fetchMetrics).toHaveBeenCalledOnce();
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
    const remote = metrics();
    const metricTransport: Transport<Row> = { ...remote.metricTransport, fetchQueryV3,
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
    expect(remote.fetchRows).not.toHaveBeenCalled();
    expect(remote.fetchMetrics).not.toHaveBeenCalled();
    expect(current.api.requestActivity.entries).toMatchObject([{ kind: "QueryV3", status: "success" }]);
  });
});
