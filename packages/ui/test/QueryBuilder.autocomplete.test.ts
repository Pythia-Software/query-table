// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import type { DistinctValuesResult, FieldSchema, QueryState } from "@pythia-software/query-table-core";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const names = ["exploration", "exploration-service", "exploration-service-v2", "gbw-utilities", "general-purpose-repository", "go-query-table-integration-with-a-long-unbroken-suffix-abcdefghijklmnopqrstuvwxyz"];
type Row = { repository_name: string; tags: string[]; status: string };
const schema: FieldSchema<Row> = { name: "autocomplete", idField: "repository_name", fields: [
  { name: "repository_name", label: "Repository", type: "text", source: { kind: "backend" }, filter: { values: { source: "autocomplete" } } },
  { name: "tags", label: "Tags", type: "textarray", source: { kind: "backend" }, filter: { values: { source: "autocomplete" } } },
  { name: "status", label: "Status", type: "text", source: { kind: "backend" }, filter: { values: { source: "static", options: ["ready", "waiting"] } } },
] };
const initialQuery: QueryState = { select: [{ field: "repository_name" }], where: [{ field: "repository_name", op: "=", value: "" }], orderBy: [], limit: 25, offset: 0 };
const rows: Row[] = [];
let container: HTMLDivElement, root: Root, api: QueryTableApi<Row>;
let fetchValues: ReturnType<typeof vi.fn<QueryTableApi<Row>["filterValues"]>>;
let rerender: () => void;
function Fixture() {
  api = useQueryTable({ schema, initialQuery, clientRows: rows, debounceMs: 0 });
  const [total, setTotal] = useState(0);
  rerender = () => setTotal(previous => previous + 1);
  return h(QueryBuilder<Row>, { api: { ...api, filterValues: fetchValues }, fields: schema.fields, total });
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"][aria-label^="Value for"]')!;
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const selectedValue = () => (api.query.where[0] as { value: string }).value;
async function tick(ms = 200) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function key(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { input().dispatchEvent(event); });
  return event;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(mobile = false) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  await act(async () => root.render(h(Fixture)));
  if (mobile) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Edit filter:"]')!.click());
  await act(async () => input().focus());
}
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  fetchValues = vi.fn(async (_field, search) => ({ values: names.filter(name => name.includes(search)), hasMore: false }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("debounces filtering, supports clearing and arbitrary values, and ignores unrelated rerenders", async () => {
  await mount();
  // QueryBuilder separately probes null availability without a debounce.
  fetchValues.mockClear();
  await type("exp"); await tick(150); await type("exploration-"); await tick(199);
  expect(fetchValues).not.toHaveBeenCalled();
  await tick(1);
  expect(fetchValues).toHaveBeenCalledExactlyOnceWith("repository_name", "exploration-");
  expect(options().map(option => option.textContent)).toEqual(names.slice(1, 3));
  await act(async () => rerender()); await tick();
  expect(fetchValues).toHaveBeenCalledTimes(1);
  await type("arbitrary value"); await tick();
  expect(selectedValue()).toBe("arbitrary value");
  expect(options()).toHaveLength(0);
  expect(document.querySelector('[role="status"]')!.textContent).toContain("No matching values");
  await type(""); await tick();
  expect(selectedValue()).toBe(""); expect(options()).toHaveLength(names.length);
});

it("exposes active options, selects the complete value, and preserves input focus", async () => {
  await mount(); await tick();
  expect(input().getAttribute("aria-expanded")).toBe("true");
  expect(input().getAttribute("aria-controls")).toBe(document.querySelector('[role="listbox"]')!.id);
  await key("ArrowDown"); await key("ArrowDown");
  expect(document.getElementById(input().getAttribute("aria-activedescendant")!)!.textContent).toBe(names[1]);
  expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(input());
  await key("Enter");
  expect(selectedValue()).toBe(names[1]); expect(input().getAttribute("aria-expanded")).toBe("false");
  expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  await tick(); await key("ArrowUp");
  expect(input().getAttribute("aria-expanded")).toBe("true");
  await key("End"); await key("Home"); await key("Escape");
  expect(selectedValue()).toBe(names[1]); expect(document.activeElement).toBe(input());
});

it("does not choose on Tab, plain Enter, or IME confirmation; pointer selection retains focus", async () => {
  await mount(); await tick();
  expect((await key("Enter")).defaultPrevented).toBe(false);
  await key("ArrowDown");
  expect((await key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
  expect(selectedValue()).toBe("");
  expect((await key("Tab")).defaultPrevented).toBe(false);
  expect(selectedValue()).toBe(""); expect(input().getAttribute("aria-expanded")).toBe("false");
  await act(async () => input().click());
  const option = options().at(-1)!;
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => { option.dispatchEvent(press); option.click(); });
  expect(press.defaultPrevented).toBe(true);
  expect(selectedValue()).toBe(names.at(-1)); expect(document.activeElement).toBe(input());
});

it("keeps freeform editing available through loading, failure, and refinement hints", async () => {
  await mount();
  expect(document.querySelector('[role="listbox"]')!.getAttribute("aria-busy")).toBe("true");
  await tick();
  fetchValues.mockRejectedValueOnce(new Error("offline"));
  await type("offline"); await tick();
  expect(document.querySelector('[role="status"]')!.textContent).toContain("Suggestions unavailable");
  expect(selectedValue()).toBe("offline");
  fetchValues.mockResolvedValueOnce({ values: names, hasMore: true });
  await type(""); await tick();
  expect(document.querySelector('[role="status"]')!.textContent).toContain("keep typing to refine");
});

it("rejects late responses for previous text, field, and query context", async () => {
  const pending: Array<(result: DistinctValuesResult) => void> = [];
  await mount(); await tick();
  fetchValues.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await type("old"); await tick();
  await type("new");
  expect(options()).toHaveLength(0);
  await tick();
  await act(async () => pending[1]!({ values: ["new-result"], hasMore: false }));
  await act(async () => pending[0]!({ values: ["old-result"], hasMore: true }));
  expect(options().map(option => option.textContent)).toEqual(["new-result"]);
  await type(""); await tick();
  await act(async () => api.setQuery(query => ({ ...query, where: [{ field: "tags", op: "includes", value: "" }] })));
  expect(options()).toHaveLength(0); await tick();
  const previousFieldRequest = pending.at(-1)!;
  await act(async () => pending[2]!({ values: ["wrong-field"], hasMore: false }));
  expect(options()).toHaveLength(0);
  // Invalidate the field's current request with a new filter context.
  await act(async () => api.setQuery(query => ({ ...query, where: [...query.where, { field: "status", op: "=", value: "ready" }] })));
  await tick();
  await act(async () => previousFieldRequest({ values: ["wrong-context"], hasMore: false }));
  expect(options()).toHaveLength(0);
  await act(async () => pending.at(-1)!({ values: ["current-tag"], hasMore: false }));
  expect(options().map(option => option.textContent)).toEqual(["current-tag"]);
  await key("ArrowDown"); await key("Enter"); expect(selectedValue()).toBe("current-tag");
});

it("works inside mobile filter dialogs without a second modal or closing the enclosing dialog", async () => {
  await mount(true); await tick();
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')!.contains(document.querySelector('[role="listbox"]'))).toBe(true);
  await key("Escape");
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await key("ArrowDown"); await key("Enter");
  expect(selectedValue()).toBe(names[0]);
});

it("retains static selects and closes suggestions when focus leaves", async () => {
  await mount(); await tick();
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.focus());
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => api.setQuery(query => ({ ...query, where: [{ field: "status", op: "=", value: "ready" }] })));
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Value for Status"]')!;
  expect(select.tagName).toBe("SELECT"); expect(select.value).toBe("ready");
});
