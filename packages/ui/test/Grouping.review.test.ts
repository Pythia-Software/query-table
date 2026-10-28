// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_GROUP_BY_FIELDS, normalizeQueryState, createGroupingModel, type FieldSchema, type GroupedRow, type QueryState, type SummaryColumn, type QueryRequestV3, type QueryResultV3, type Transport } from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { QueryBuilder } from "../src/QueryBuilder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema<GroupedRow> = {
  name: "grouping-ui-review", idField: "id",
  fields: [
    ...["team", "region"].map(name => ({ name, label: name, type: "text" as const, source: { kind: "backend" as const } })),
    { name: "amount", label: "Amount", type: "number", source: { kind: "backend" } },
  ],
};
const rows = [{ id: 1, team: "a", region: "east", amount: 10, "value]part": 12 }];
let root: Root;
let container: HTMLDivElement;
let api: QueryTableApi<GroupedRow>;
function Fixture({ initialQuery, sourceSchema = schema }: { initialQuery: QueryState; sourceSchema?: FieldSchema<GroupedRow> }) {
  api = useQueryTable({ schema: sourceSchema, initialQuery, clientRows: rows, debounceMs: 0 });
  return createElement(QueryBuilder<GroupedRow>, { api, fields: api.schema!.fields, total: api.total });
}

it("previews server group drafts, cancels superseded requests and ignores late responses", async () => {
  const requests: {request:QueryRequestV3;signal:AbortSignal | undefined;resolve:(result:QueryResultV3)=>void}[]=[];
  const response = (request:QueryRequestV3, team="fresh", total=77):QueryResultV3 => {
    const projection=createGroupingModel(schema).resultSchema(request.grouping!.keys,request.grouping!.summaries);
    return {version:3,now:request.now,sourceTotal:100,total:1,rows:request.rows?[{__qt_group_id__:'[["team","a"]]',team,total}]:[],metrics:[],
      schema:{name:projection.name,idField:projection.idField,fields:projection.fields.map(({name,type})=>({name,type}))},
      execution:{profile:request.profile,planToken:"",resolvedRevisions:{},fields:{}}};
  };
  const transport:Transport<GroupedRow>={fetchRows:async()=>({rows:[],total:0}),
    queryCapabilities:{version:3,profile:"qt-sqlite-v1",groupedRows:true,calendarGrouping:true,computedSourceFilters:false,regex:false,maxRows:10000,maxGroups:2000,maxPopulation:250000},
    fetchQueryV3:async(request,signal)=>request.rows&&request.result.limit===8
      ?new Promise(resolve=>requests.push({request,signal,resolve})):response(request)};
  const initialQuery=normalizeQueryState({select:[{field:"team"},{field:"total"}],grouping:{keys:["team"],summaries:[{id:"total",op:"sum",field:"amount"}],representative:null,source:normalizeQueryState({})}});
  function RemoteFixture(){api=useQueryTable({schema,initialQuery,transport,debounceMs:0});return createElement(QueryBuilder<GroupedRow>,{api,fields:api.schema!.fields,total:api.total})}
  await act(async()=>root.render(createElement(RemoteFixture)));
  await act(async()=>{await vi.advanceTimersByTimeAsync(25)});
  await click("Customize columns");
  expect(requests).toHaveLength(1);
  expect(document.querySelector(".qt-columns-editor")?.textContent).toContain("Loading server preview");
  const column=document.querySelector<HTMLButtonElement>('.qt-column-item-name[title="Total Amount"]')!;
  await act(async()=>column.click());
  const average=Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Summary choices"] button')).find(button=>button.querySelector("strong")?.textContent==="Average")!;
  expect(average).toBeDefined();await act(async()=>average.click());
  expect(requests).toHaveLength(2);expect(requests[0]!.signal?.aborted).toBe(true);
  await act(async()=>requests[1]!.resolve(response(requests[1]!.request)));
  expect(document.querySelector(".qt-group-preview-table")?.textContent ?? document.querySelector(".qt-columns-editor")?.textContent).toContain("fresh");
  await act(async()=>requests[0]!.resolve(response(requests[0]!.request,"stale",1)));
  expect(document.querySelector(".qt-columns-editor")?.textContent).not.toContain("stale");
  await click("Close column editor");await clickText("Discard changes");expect(requests[1]!.signal?.aborted).toBe(true);
});
async function mount(keys: string[], sourceSchema = schema, diagnostics?: string[], summaries: SummaryColumn[] = []) {
  const initialQuery = normalizeQueryState({
    select: [...keys.map(field => ({ field })), ...summaries.map(s => ({ field: s.id }))],
    grouping: { keys, summaries, representative: summaries.some(s => s.op === "row") ? { orderBy: [{ field: "amount", dir: "desc", nulls: "last" }] } : null, source: normalizeQueryState({}), ...(diagnostics ? { diagnostics } : {}) },
  });
  await act(async () => root.render(createElement(Fixture, { initialQuery, sourceSchema })));
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull();
  await act(async () => button!.click());
}
async function clickText(text: string, selector = "button") {
  const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.textContent?.trim() === text);
  expect(element, text).toBeDefined();
  await act(async () => element!.click());
}
async function pick(text: string) { await clickText(text, ".qt-picker-label"); }
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("opens Customize columns on a stale group key and shows validation without discarding the key", async () => {
  await mount(["missing", "team"]);
  await click("Customize columns");
  const dialog = document.querySelector('[role="dialog"][aria-label="Select columns"]');
  expect(dialog).not.toBeNull();
  expect(dialog!.textContent).toContain("missing");
  expect(dialog!.querySelector('[role="alert"]')?.textContent).toMatch(/valid group keys/);
  const apply = Array.from(dialog!.querySelectorAll("button")).find(b => b.textContent === "Apply columns")!;
  expect(apply.disabled).toBe(true);
  await click("Close column editor");
  await click("Remove missing grouping");
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  expect(api.error).toBeNull();
  expect(api.rows).toHaveLength(1);
});

it("does not offer a 21st group key and makes the picker available after removing one", async () => {
  const keys = Array.from({ length: MAX_GROUP_BY_FIELDS + 1 }, (_, i) => `key${i}`);
  const wide = { ...schema, fields: keys.map(name => ({ ...schema.fields[0]!, name, label: name })) };
  await mount(keys.slice(0, -1), wide);
  expect(container.querySelector('[aria-label="Group by additional key"]')).toBeNull();
  await click("Remove key0 grouping");
  expect(container.querySelector('[aria-label="Group by additional key"]')).not.toBeNull();
});

it.each(["grouping", "column"] as const)("reports invalid %s removals in place instead of throwing an event or render error", async kind => {
  await mount(["team", "region"], schema, ["Invalid grouping definition."]);
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
  window.addEventListener("error", onError);
  try {
    await click(`Remove team ${kind}`);
    expect(errors).toEqual([]);
    expect(api.query.grouping?.keys).toEqual(["team", "region"]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Invalid grouping definition.");
    expect(container.querySelector(".qt-qb")).not.toBeNull();
  } finally { window.removeEventListener("error", onError); }
});

it("surfaces retained grouping diagnostics inside the columns editor", async () => {
  await mount(["team"], schema, ["Invalid grouping definition."]);
  await click("Customize columns");
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Invalid grouping definition.");
});

for (const invalid of ["diagnostics", "key", "summary"] as const) {
  it.each(["add summary", "change summary", "representative"] as const)(`handles %s when a saved grouping has an invalid ${invalid}`, async intent => {
    const summaries: SummaryColumn[] = [{ id: "total", op: "sum", field: "amount" }];
    if (invalid === "summary") summaries.push({ id: "stale", op: "sum", field: "missing" });
    await mount(invalid === "key" ? ["team", "missing"] : ["team"], schema,
      invalid === "diagnostics" ? ["Invalid grouping definition."] : undefined, summaries);
    const before = api.query;
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", onError);
    try {
      if (intent === "add summary") {
        await click("Add column"); await pick("Row count");
      } else if (intent === "change summary") {
        const select = container.querySelector<HTMLSelectElement>('[aria-label="Aggregation for Total Amount"]')!;
        await act(async () => { select.value = "avg"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      } else {
        await click("Add representative row"); await pick("Amount"); await clickText("Apply ordering");
      }
      expect(errors).toEqual([]);
      expect(api.query).toBe(before);
      expect(container.querySelector(".qt-group-notice")?.textContent).toMatch(/Invalid|valid group keys/);
      expect(document.querySelector(".qt-picker, .qt-representative-editor")).toBeNull();
    } finally { window.removeEventListener("error", onError); }
  });
}

it.each(["quick picker", "column editor"] as const)("escapes field names in custom aggregate seeds from the %s", async entry => {
  const bracketSchema: FieldSchema<GroupedRow> = { ...schema, fields: [...schema.fields,
    { name: "value]part", label: "Bracket value", type: "number", source: { kind: "backend" } },
  ] };
  await mount(["team"], bracketSchema);
  if (entry === "column editor") { await click("Customize columns"); await click("Add column to view"); }
  else await click("Add column");
  await pick("Bracket value"); await pick("Custom aggregate…");
  await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(100); });
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Aggregate column formula"]')?.value).toBe("AVG([value]]part])");
  const apply = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Apply columns")!;
  expect(apply.disabled).toBe(false);
  await act(async () => apply.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  const summary = api.query.grouping!.summaries[0]!;
  expect(api.error).toBeNull();
  expect(api.rows[0]![summary.id]).toBe(12);
});

it.each(["sum", "row", "formula"] as const)("can remove a stale %s definition and undo the removal inside the editor", async op => {
  await mount(["team"], schema, undefined, [{ id: "stale", op, field: "missing", ...(op === "formula" ? { expression: "SUM([missing])" } : {}) }]);
  await click("Customize columns");
  const remove = () => click(op === "formula" ? "Remove Custom aggregate" : op === "row" ? "Remove Representative · missing" : "Remove Total missing");
  await remove();
  const apply = () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Apply columns")!;
  expect(apply().disabled).toBe(false);
  await clickText("Undo", ".qt-column-removed button");
  expect(apply().disabled).toBe(true);
  await remove();
  await act(async () => apply().click());
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  expect(api.query.grouping!.summaries).toEqual([]);
  expect(api.error).toBeNull();
  expect(api.rows).toHaveLength(1);
});

it.each(["aggregate", "formula", "quick formula"])("cancels a new %s definition when its column is removed, including after Undo", async kind => {
  await mount(["team"]);
  const before = api.query;
  if (kind === "quick formula") await click("Add column");
  else { await click("Customize columns"); await click("Add column to view"); }
  await pick("Amount");
  await pick(kind === "aggregate" ? "Total" : "Custom aggregate…");
  const label = kind === "aggregate" ? "Total Amount" : "Custom aggregate";
  await click(`Remove ${label}`);
  await clickText("Undo", ".qt-column-removed button");
  expect(document.querySelector(`[aria-label="Remove ${label}"]`)).not.toBeNull();
  await click(`Remove ${label}`);
  await clickText("Apply columns");
  expect(api.query).toEqual(before);
  expect(api.query.grouping!.summaries).toEqual([]);
  await click("Add column");
  expect(Array.from(document.querySelectorAll(".qt-picker-label"), el => el.textContent)).not.toContain(label);
});

it("closes without a discard prompt after adding and removing a new aggregate", async () => {
  await mount(["team"]);
  await click("Customize columns"); await click("Add column to view"); await pick("Row count");
  await click("Remove Row count");
  await click("Close column editor");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps an existing valid summary available when its column is hidden", async () => {
  const original: SummaryColumn = { id: "total", op: "sum", field: "amount" };
  await mount(["team"], schema, undefined, [original]);
  await click("Customize columns"); await click("Remove Total Amount"); await clickText("Apply columns");
  expect(api.query.select).toEqual([{ field: "team" }]);
  expect(api.query.grouping!.summaries).toEqual([original]);
  await click("Add column"); await pick("Total Amount");
  expect(api.query.select).toContainEqual({ field: "total" });
  expect(api.query.grouping!.summaries).toEqual([original]);
});

it.each(["quick picker", "column editor"])("restores a hidden grouped computed column from the %s without adding an aggregate", async entry => {
  await mount(["team"], schema, undefined, [{ id: "total", op: "sum", field: "amount" }]);
  await act(async () => { await api.computed.save({ id: "double", label: "Double total", expression: { language: "qt-expr", version: 1, source: "[total] * 2" } }, null); });
  await act(async () => { api.select.show("@computed/double"); });
  await click("Remove Double total column");
  const original = api.query.grouping!.summaries;
  if (entry === "column editor") await click("Customize columns");
  const openPicker = () => click(entry === "column editor" ? "Add column to view" : "Add column");
  await openPicker();
  const option = Array.from(document.querySelectorAll(".qt-picker-item")).find(el => el.textContent?.includes("Double total"));
  expect(option).toBeDefined();
  expect(option!.querySelector('[data-icon="chevronRight"]')).toBeNull();
  await pick("Double total");
  expect(document.querySelector(".qt-picker")).toBeNull();
  await openPicker();
  expect(Array.from(document.querySelectorAll(".qt-picker-label"), el => el.textContent)).not.toContain("Double total");
  // Choosing a source field should still open the aggregation step.
  await pick("Amount");
  expect(document.querySelector(".qt-picker")?.textContent).toContain("Average");
  await click("Close field picker");
  if (entry === "column editor") await clickText("Apply columns");
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  expect(api.query.select).toContainEqual({ field: "@computed/double" });
  expect(api.query.grouping!.summaries).toEqual(original);
  expect(api.computed.definitions).toHaveLength(1);
  expect(api.computed.definitions[0]!.expression.source).toBe("[total] * 2");
});

it.each(["team", "Total Amount", "Custom aggregate"])("resets panels for the selected %s column and preserves manual toggles", async label => {
  await mount(["team"], schema, undefined, [
    { id: "total", op: "sum", field: "amount" },
    { id: "custom", op: "formula", expression: "MEDIAN([amount])" },
  ]);
  await click("Customize columns");
  await clickText(label, ".qt-column-item-label");
  const functionsShown = () => document.querySelector('[aria-label="Functions panel"]')!.getAttribute("aria-pressed") === "true";
  const expectedFunctions = label === "Custom aggregate";
  expect(functionsShown()).toBe(expectedFunctions);
  await click("Functions panel");
  await click("Preview panel");
  expect(functionsShown()).toBe(!expectedFunctions);
  await clickText("Reset layout");
  expect(functionsShown()).toBe(expectedFunctions);
  for (const pane of ["Columns", "Column", "Preview"])
    expect(document.querySelector(`[aria-label="${pane} panel"]`)!.getAttribute("aria-pressed")).toBe("true");
  await click("Functions panel");
  expect(functionsShown()).toBe(!expectedFunctions);
});

it("sets a summary column format from the column editor", async () => {
  await mount(["team"], schema, undefined, [{ id: "total", op: "avg", field: "amount" }]);
  await click("Customize columns");
  await act(async () => document.querySelector<HTMLButtonElement>('.qt-column-item-name[title="Average Amount"]')!.click());
  const change = async (label: string, value: string) => {
    const control = document.querySelector<HTMLSelectElement | HTMLInputElement>(`[aria-label="${label}"]`)!;
    expect(control, label).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")!.set!;
    await act(async () => { setter.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  await change("Column format", "percent");
  await change("Decimal places", "1");
  await clickText("Apply columns");
  expect(api.query.grouping!.summaries).toEqual([{ id: "total", op: "avg", field: "amount", display: { kind: "percent", decimals: 1 } }]);
  expect(api.schema!.fields.find(field => field.name === "total")?.display).toEqual({ kind: "percent", decimals: 1 });
  await click("Customize columns");
  await act(async () => document.querySelector<HTMLButtonElement>('.qt-column-item-name[title="Average Amount"]')!.click());
  await change("Column format", "");
  await clickText("Apply columns");
  expect(api.query.grouping!.summaries).toEqual([{ id: "total", op: "avg", field: "amount" }]);
});

it("clears a summary format when the column switches to a representative row value", async () => {
  const rate: SummaryColumn = { id: "total", op: "avg", field: "amount", display: { kind: "percent", decimals: 1 } };
  const example: SummaryColumn = { id: "example", op: "row", field: "region" };
  await mount(["team"], schema, undefined, [rate, example]);
  await click("Customize columns");
  await act(async () => document.querySelector<HTMLButtonElement>('.qt-column-item-name[title="Average Amount"]')!.click());
  expect(document.querySelector('[aria-label="Column format"]')).not.toBeNull();
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>(".qt-column-row-choice button")).find(b => b.textContent?.includes("Representative row"))!.click());
  expect(document.querySelector('[aria-label="Column format"]')).toBeNull();
  await clickText("Apply columns");
  expect(api.query.grouping!.summaries[0]).toEqual({ id: "total", op: "row", field: "amount" });
  expect(api.schema!.fields.find(field => field.name === "total")?.display).toBeUndefined();
});

it("clears a summary format when the headless controller switches it to a row value", async () => {
  const rate: SummaryColumn = { id: "total", op: "avg", field: "amount", display: { kind: "percent" } };
  await mount(["team"], schema, undefined, [rate, { id: "example", op: "row", field: "region" }]);
  await act(async () => api.grouping!.changeSummary("total", "row"));
  expect(api.query.grouping!.summaries[0]).toEqual({ id: "total", op: "row", field: "amount" });
  await act(async () => api.grouping!.changeSummary("example", "min"));
  expect(api.query.grouping!.summaries[1]).toEqual({ id: "example", op: "min", field: "region" });
});

it("picks a calendar interval for a datetime group key and shows it on the chip", async () => {
  const timed: FieldSchema<GroupedRow> = { ...schema, fields: [...schema.fields,
    { name: "at", label: "At", type: "datetime", source: { kind: "backend" }, aggregate: { groupable: true } }] };
  await mount(["at", "team"], timed);
  const interval = container.querySelector<HTMLSelectElement>('select[aria-label="Interval for At"]')!;
  expect(interval).not.toBeNull();
  expect(container.querySelector('select[aria-label="Interval for team"]')).toBeNull();
  expect(interval.value).toBe("");
  await act(async () => {
    interval.value = "day";
    interval.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const [key] = api.query.grouping!.keys;
  expect(key).toMatchObject({ field: "at", interval: "day" });
  expect(typeof (key as { timeZone?: string }).timeZone).toBe("string");
  expect(api.query.grouping!.keys[1]).toBe("team");
  expect(container.querySelector(".qt-group-key-interval")?.textContent).toContain("by day");
  const exact = container.querySelector<HTMLSelectElement>('select[aria-label="Interval for At"]')!;
  await act(async () => {
    exact.value = "";
    exact.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.query.grouping!.keys).toEqual(["at", "team"]);
  await click("Remove At grouping");
  expect(api.query.grouping!.keys).toEqual(["team"]);
});
