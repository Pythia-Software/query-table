export interface SortExtractionResult {
  extracted: string | null;
  matched: boolean;
}

export function extractSortSamples(pattern: string, values: unknown[]): SortExtractionResult[] {
  const regex = new RegExp(pattern);
  return values.map((value) => {
    const match = value == null ? null : regex.exec(String(value));
    return { extracted: match ? (match.length > 1 ? match[1] ?? null : match[0]!) : null, matched: match != null };
  });
}

export function previewSortExtraction(pattern: string, values: unknown[], signal: AbortSignal): Promise<SortExtractionResult[]> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!values.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      const url = URL.createObjectURL(new Blob([`const extract = ${extractSortSamples.toString()}; self.onmessage = event => { try { self.postMessage({ results: extract(event.data.pattern, event.data.values) }); } catch (error) { self.postMessage({ error: error.message }); } };`], { type: "text/javascript" }));
      try {
        worker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      reject(new Error("Regex preview worker unavailable. Check your browser’s worker permissions."));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Regex preview timed out. Simplify the pattern."));
    }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ results: SortExtractionResult[]; error?: string }>) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.results);
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("Regex preview worker failed."));
    };
    try {
      worker.postMessage({ pattern, values });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
