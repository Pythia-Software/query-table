// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ColumnPreview } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { SortExtractionEditor } from "../src/SortExtractionEditor";
import { extractSortSamples, previewSortExtraction } from "../src/sortExtractionPreview";

vi.mock("../src/sortExtractionPreview", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/sortExtractionPreview")>();
  return { ...original, previewSortExtraction: vi.fn(async (pattern: string, values: unknown[]) => original.extractSortSamples(pattern, values)) };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sample: ColumnPreview = {
  dependencies: ["job"], processed: 4, total: 12, nulls: 1, errors: 0,
  groups: [
    { inputs: ["build-42"], result: { value: "build-42" }, count: 2 },
    { inputs: ["other"], result: { value: "other" }, count: 1 },
    { inputs: [null], result: { value: null }, count: 1 },
  ],
};
let container: HTMLDivElement;
let root: Root;
let sampleRequest: ReturnType<typeof vi.fn>;
const onApply = vi.fn();
const onRemove = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sampleRequest = vi.fn().mockResolvedValue(sample);
  vi.mocked(previewSortExtraction).mockImplementation(async (pattern, values) => extractSortSamples(pattern, values));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(initialPattern?: string) {
  const api = { computed: { preview: sampleRequest } } as unknown as QueryTableApi<unknown>;
  await act(async () => root.render(createElement(SortExtractionEditor, { api, field: "job", label: "Job", initialPattern, onApply, onRemove, onClose })));
  await act(async () => vi.advanceTimersByTimeAsync(201));
}

async function changePattern(pattern: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, pattern);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(201));
}

const button = (text: string) => Array.from(container.querySelectorAll("button")).find((target) => target.textContent === text)!;

it("previews extraction while typing without mutating the sort until Apply", async () => {
  await render();
  await changePattern("build-(\\d+)");
  expect(sampleRequest).toHaveBeenCalledOnce();
  expect(sampleRequest).toHaveBeenCalledWith("[job]", 100, expect.any(AbortSignal));
  const rows = container.querySelectorAll("tbody tr");
  expect(rows[0]!.textContent).toBe("build-42422");
  expect(rows[1]!.textContent).toContain("NULLNo match");
  expect(rows[2]!.textContent).toContain("NULLNull input");
  expect(container.querySelector('[role="status"]')!.textContent).toContain("4 matching rows (3 distinct values)");
  expect(onApply).not.toHaveBeenCalled();
  await act(async () => button("Apply extraction").click());
  expect(onApply).toHaveBeenCalledWith("build-(\\d+)");
});

it("validates malformed patterns and clears stale extracted values", async () => {
  await render("build-(\\d+)");
  await changePattern("[");
  expect(container.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button("Apply extraction").disabled).toBe(true);
  expect(container.querySelectorAll("tbody code")).toHaveLength(0);
  await changePattern("\\d+");
  expect(button("Apply extraction").disabled).toBe(false);
  expect(container.querySelector("tbody code")!.textContent).toBe("42");
});

it("cancels draft changes and keeps removal inside configuration", async () => {
  await render("build-(\\d+)");
  await changePattern("other");
  await act(async () => button("Cancel").click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
  await act(async () => button("Remove extraction").click());
  expect(onRemove).toHaveBeenCalledOnce();
});

it("ignores aborted results when a newer pattern has already been previewed", async () => {
  let resolveOld: (results: ReturnType<typeof extractSortSamples>) => void = () => undefined;
  vi.mocked(previewSortExtraction).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  await render("build-(\\d+)");
  const oldSignal = vi.mocked(previewSortExtraction).mock.calls[0]![2];
  await changePattern("other");
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld(extractSortSamples("build-(\\d+)", ["build-42", "other", null])));
  expect(container.querySelectorAll("tbody code")[1]!.textContent).toBe("other");
  expect(container.querySelectorAll("tbody code")[0]!.textContent).toBe("NULL");
});

it("allows valid configuration with an empty sample and exposes fetch or timeout errors", async () => {
  sampleRequest.mockResolvedValueOnce({ ...sample, groups: [], processed: 0, total: 0 });
  await render("\\d+");
  expect(container.textContent).toContain("No matching rows to preview");
  expect(button("Apply extraction").disabled).toBe(false);
  sampleRequest.mockRejectedValueOnce(new Error("Sample fetch failed"));
  await act(async () => root.render(null));
  await render();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Sample fetch failed");
  expect(button("Apply extraction").disabled).toBe(true);
});

it("blocks applying a pattern when its preview times out", async () => {
  vi.mocked(previewSortExtraction).mockRejectedValueOnce(new Error("Regex preview timed out"));
  await render("(a+)+$");
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("timed out");
  expect(button("Apply extraction").disabled).toBe(true);
});

it("re-samples when the configurator's field changes and never shows the previous field's preview", async () => {
  const api = { computed: { preview: sampleRequest } } as unknown as QueryTableApi<unknown>;
  const fieldOptions = [{ name: "job", label: "Job" }, { name: "host", label: "Host" }];
  const onFieldChange = vi.fn();
  const renderField = (field: string, label: string) => act(async () => root.render(createElement(SortExtractionEditor, { api, field, label, fieldOptions, onFieldChange, title: "Sort with regex extraction", applyLabel: "Add sort", onApply, onRemove, onClose })));
  await renderField("job", "Job");
  await changePattern("(\\w+)");
  expect(container.querySelector("h2")!.textContent).toBe("Sort with regex extraction");
  expect(button("Add sort").disabled).toBe(false);

  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "host";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onFieldChange).toHaveBeenCalledWith("host");

  let resolveHost!: (value: ColumnPreview) => void;
  sampleRequest.mockReturnValueOnce(new Promise<ColumnPreview>((resolve) => { resolveHost = resolve; }));
  await renderField("host", "Host");
  expect(sampleRequest).toHaveBeenLastCalledWith("[host]", 100, expect.any(AbortSignal));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(button("Add sort").disabled).toBe(true);

  await act(async () => resolveHost({ ...sample, groups: [{ inputs: ["db-1"], result: { value: "db-1" }, count: 5 }] }));
  expect(button("Add sort").disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(201));
  expect(container.querySelector("tbody tr")!.textContent).toBe("db-1db5");
  expect(button("Add sort").disabled).toBe(false);
});
