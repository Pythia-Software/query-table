import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSortSamples, previewSortExtraction } from "../src/sortExtractionPreview";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sort extraction semantics", () => {
  it("uses the first capture, falling back to the whole match only without captures", () => {
    expect(extractSortSamples("build-(\\d+)", ["build-42", "other", null])).toEqual([
      { extracted: "42", matched: true }, { extracted: null, matched: false }, { extracted: null, matched: false },
    ]);
    expect(extractSortSamples("\\d+", ["build-42"])[0]!.extracted).toBe("42");
    expect(extractSortSamples("(a)?b", ["b"])[0]).toEqual({ extracted: null, matched: true });
  });

  it("preserves empty matches, non-Unicode sort semantics, and numeric inputs", () => {
    expect(extractSortSamples("", ["value"])[0]).toEqual({ extracted: "", matched: true });
    expect(extractSortSamples(".", ["😀"])[0]!.extracted).toBe("\ud83d");
    expect(extractSortSamples("(\\d+)", [42])[0]!.extracted).toBe("42");
    expect(() => extractSortSamples("[", ["value"])).toThrow();
  });
});

function installWorker() {
  const workers: PreviewWorker[] = [];
  class PreviewWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { workers.push(this); }
  }
  vi.stubGlobal("Worker", PreviewWorker);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return workers;
}

describe("isolated sort extraction preview", () => {
  it("sends values to a worker and releases it after receiving results", async () => {
    const workers = installWorker();
    const pending = previewSortExtraction("(\\d+)", ["job-42"], new AbortController().signal);
    expect(workers[0]!.postMessage).toHaveBeenCalledWith({ pattern: "(\\d+)", values: ["job-42"] });
    const results = [{ extracted: "42", matched: true }];
    workers[0]!.onmessage!({ data: { results } });
    await expect(pending).resolves.toEqual(results);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("terminates slow regexes without freezing the UI", async () => {
    vi.useFakeTimers();
    const workers = installWorker();
    const pending = previewSortExtraction("(a+)+$", ["aaaa!"], new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("aborts obsolete previews and reports worker failures", async () => {
    const workers = installWorker();
    const controller = new AbortController();
    const pending = previewSortExtraction(".+", ["value"], controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const failure = previewSortExtraction(".+", ["value"], new AbortController().signal);
    workers[1]!.onerror!();
    await expect(failure).rejects.toThrow("worker failed");
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });

  it("handles worker unavailability and already aborted or empty requests", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(previewSortExtraction("", [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(previewSortExtraction("", [], new AbortController().signal)).resolves.toEqual([]);
    vi.stubGlobal("Worker", undefined);
    await expect(previewSortExtraction("", ["value"], new AbortController().signal)).rejects.toThrow("worker unavailable");
  });
});
