// @vitest-environment jsdom
//
// Auto-refresh ↔ onRefresh wiring. The headline guarantee: the internal
// auto-refresh interval and the public `api.refresh()` are the SAME seam, so a
// consumer-supplied `onRefresh` fires identically from both — the fix for
// client-mode consumers whose real fetch lives outside the hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FieldSchema, StorageAdapter, Transport } from "@query-table/core";
import { useQueryTable, type QueryTableApi, type UseQueryTableOptions } from "../src/useQueryTable";

// React's act() requires this flag in a non-test-runner host like ours.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: number;
  name: string;
}

const schema: FieldSchema<Row> = {
  name: "things",
  idField: "id",
  defaultLimit: 100,
  defaultSelect: [{ field: "name" }],
  fields: [
    { name: "id", label: "Id", type: "number", source: { kind: "backend" } },
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
  ],
};

const clientRows: Row[] = [
  { id: 1, name: "alpha" },
  { id: 2, name: "bravo" },
];

// In-memory storage so mount-time restore is a deterministic no-op (no
// localStorage, no async query swap mid-test).
const storage: StorageAdapter = {
  loadLast: async () => null,
  saveLast: async () => {},
  listSaved: async () => [],
  saveNamed: async (key, name, query, savedAt) => ({ id: "x", name, savedAt, query }),
  deleteSaved: async () => {},
};

// Minimal hook renderer over react-dom/client. Avoids pulling in
// @testing-library just for one suite.
function renderHook<R>(useHook: () => R) {
  const container = document.createElement("div");
  let root!: Root;
  const result = { current: undefined as unknown as R };

  function Probe() {
    result.current = useHook();
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return {
    result,
    unmount() {
      act(() => root.unmount());
    },
  };
}

// Advance fake time inside act() so React flushes the state updates the timers
// schedule (the debounced fetch, the auto-refresh poll-count bumps).
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  // now: 0 makes startedAt/stopsAt deterministic; Date.now() is the hook's clock.
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useQueryTable auto-refresh + onRefresh", () => {
  it("invokes onRefresh on every auto-refresh tick (N ticks → N calls)", () => {
    const onRefresh = vi.fn();
    const { result, unmount } = renderHook(() =>
      useQueryTable<Row>({ schema, clientRows, storage, syncUrl: false, onRefresh }),
    );

    // freq 1000ms over a 5000ms window → 5 scheduled polls. start() fires the
    // first refresh synchronously.
    act(() => result.current.autoRefresh.start({ frequencyMs: 1000, turnOffAfterMs: 5000 }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Each interval tick before the stop time adds exactly one more call.
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(4);
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(5);

    // At t=5000 the window closes: the tick stops instead of refreshing, and
    // the interval is torn down — no further calls however long we wait.
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(5);
    expect(result.current.autoRefresh.status).toBeNull();
    advance(5000);
    expect(onRefresh).toHaveBeenCalledTimes(5);

    unmount();
  });

  it("manual api.refresh() and an auto-refresh tick invoke onRefresh identically", () => {
    const onRefresh = vi.fn();
    const { result, unmount } = renderHook(() =>
      useQueryTable<Row>({ schema, clientRows, storage, syncUrl: false, onRefresh }),
    );

    // Manual refresh → exactly one onRefresh.
    act(() => result.current.refresh());
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // A single tick → exactly one more. Same seam, same observable effect.
    act(() => result.current.autoRefresh.start({ frequencyMs: 1000, turnOffAfterMs: 5000 }));
    expect(onRefresh).toHaveBeenCalledTimes(2); // start() fires immediately
    advance(1000);
    expect(onRefresh).toHaveBeenCalledTimes(3);

    unmount();
  });

  it("without onRefresh, the internal setNonce path still re-queries on manual + auto refresh", async () => {
    const rowsResult = { rows: clientRows, total: clientRows.length };
    const fetchRows = vi.fn(async () => rowsResult);
    const transport: Transport<Row> = { fetchRows };

    const { result, unmount } = renderHook(() =>
      useQueryTable<Row>({ schema, transport, storage, syncUrl: false }),
    );

    // Initial debounced fetch.
    advance(200);
    expect(fetchRows).toHaveBeenCalledTimes(1);

    // Manual refresh re-queries via setNonce (no onRefresh in play).
    act(() => result.current.refresh());
    advance(200);
    expect(fetchRows).toHaveBeenCalledTimes(2);

    // Auto-refresh start fires immediately, then each tick re-queries too.
    act(() => result.current.autoRefresh.start({ frequencyMs: 1000, turnOffAfterMs: 3000 }));
    advance(200);
    expect(fetchRows).toHaveBeenCalledTimes(3); // immediate poll

    advance(1000); // tick 2
    advance(200);
    expect(fetchRows).toHaveBeenCalledTimes(4);

    advance(1000); // tick 3
    advance(200);
    expect(fetchRows).toHaveBeenCalledTimes(5);

    unmount();
  });
});
