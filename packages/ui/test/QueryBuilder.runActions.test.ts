// @vitest-environment jsdom

import { act, createElement as h, Fragment, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FieldSchema } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: number }
const schema: FieldSchema<Row> = {
  name: "run-actions", idField: "id",
  fields: [{ name: "id", label: "ID", type: "number", source: { kind: "backend" } }],
};
const rows: Row[] = [];
let api: QueryTableApi<Row>;
let root: Root;
let container: HTMLDivElement;
const mounted = vi.fn();
const unmounted = vi.fn();

function HostControl({ name = "Data readiness" }: { name?: string }) {
  const [opens, setOpens] = useState(0);
  useEffect(() => { mounted(name); return () => { unmounted(name); }; }, [name]);
  return h("button", { type: "button", className: "qt-btn", "aria-label": name, onClick: () => setOpens(n => n + 1) }, `Opened ${opens}`);
}

function Fixture({ slot, collapsed = false, loading = false, error = null, running = false }: {
  slot?: ReactNode; collapsed?: boolean; loading?: boolean; error?: Error | null; running?: boolean;
}) {
  api = useQueryTable<Row>({ schema, clientRows: rows, debounceMs: 0 });
  return h(QueryBuilder<Row>, {
    api: { ...api, loading, error }, fields: schema.fields, total: api.total,
    collapsed, running, runActionsBeforeActivity: slot,
    requestActivityDetails: h("p", null, "Host request diagnostics"),
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted.mockClear();
  unmounted.mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const actions = () => container.querySelector(".qt-qb-run-actions")!;
const labels = () => Array.from(actions().querySelectorAll("button"), b => b.getAttribute("aria-label") ?? b.textContent);

it.each([undefined, null, false])("keeps the existing action elements without empty spacing for %s", async slot => {
  await act(async () => root.render(h(Fixture, { slot })));
  expect(labels()).toEqual(["Request activity", "Auto-Update", "Run Now"]);
  expect(actions().children).toHaveLength(3);
  expect(mounted).not.toHaveBeenCalled();
});

it.each([false, true])("inserts host controls after polling status and before activity (collapsed=%s)", async collapsed => {
  await act(async () => root.render(h(Fixture, { collapsed, slot: h(HostControl) })));
  await act(async () => api.autoRefresh.start({ frequencyMs: 5000, turnOffAfterMs: 300000 }));
  const status = actions().firstElementChild!;
  expect(status.className).toBe("qt-qb-auto-status");
  expect(status.textContent).toContain("Every 5s");
  expect(status.nextElementSibling?.getAttribute("aria-label")).toBe("Data readiness");
  expect(labels()).toEqual(["Data readiness", "Request activity", "Auto-Update 5s", "Run Now"]);
  expect(container.querySelector(".qt-qb-editor-bar") === null).toBe(collapsed);
  await act(async () => actions().querySelector<HTMLButtonElement>('[aria-label="Request activity"]')!.click());
  expect(container.querySelector(".qt-request-activity")?.textContent).toContain("Host request diagnostics");
  await act(async () => api.autoRefresh.stop());
  expect(actions().querySelector(".qt-qb-auto-status")).toBeNull();
  expect(labels()).toEqual(["Data readiness", "Request activity", "Auto-Update", "Run Now"]);
});

it("preserves host identity, local state and focus through collapse, polling, loading, errors and rerenders", async () => {
  const render = async (props = {}) => {
    await act(async () => root.render(h(Fixture, { slot: h(HostControl), ...props })));
  };
  await render();
  const button = actions().querySelector<HTMLButtonElement>('[aria-label="Data readiness"]')!;
  button.focus();
  await act(async () => button.click());
  await act(async () => api.autoRefresh.start({ frequencyMs: 5000, turnOffAfterMs: 300000 }));
  for (const props of [{ collapsed: true }, { loading: true }, { running: true }, { error: new Error("Offline") }, {}]) {
    await render(props);
    expect(actions().querySelector('[aria-label="Data readiness"]')).toBe(button);
    expect(button.textContent).toBe("Opened 1");
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
  }
  await act(async () => api.autoRefresh.stop());
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[aria-label="Data readiness"]')).toHaveLength(1);
});

it("keeps content and lifecycles independent across builders, including fragments", async () => {
  const builders = (first: boolean) => h(Fragment, null,
    first && h(Fixture, { key: "first", slot: h(Fragment, null, h(HostControl, { name: "First readiness" }), h("button", { type: "button" }, "Extra action")) }),
    h(Fixture, { key: "second", collapsed: true, slot: h(HostControl, { name: "Second readiness" }) }),
  );
  await act(async () => root.render(builders(true)));
  const first = container.querySelector<HTMLButtonElement>('[aria-label="First readiness"]')!;
  const second = container.querySelector<HTMLButtonElement>('[aria-label="Second readiness"]')!;
  expect(labels()).toEqual(["First readiness", "Extra action", "Request activity", "Auto-Update", "Run Now"]);
  await act(async () => first.click());
  expect(first.textContent).toBe("Opened 1");
  expect(second.textContent).toBe("Opened 0");
  await act(async () => root.render(builders(false)));
  expect(container.querySelector('[aria-label="Second readiness"]')).toBe(second);
  expect(unmounted.mock.calls).toEqual([["First readiness"]]);
  expect(mounted.mock.calls).toEqual([["First readiness"], ["Second readiness"]]);
});
