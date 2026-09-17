import {
  formulaRuntime,
  type FormulaNode,
  type FormulaResult,
  type FormulaValue,
} from "@pythia-software/query-table-core";

export type FormulaWorkerFactory = () => Worker;
/** Host applications with a restrictive CSP can supply their own worker factory. */
export const createFormulaWorker: FormulaWorkerFactory = () => {
  const code = `const evaluate = ${formulaRuntime.toString()}; self.onmessage = e => { const { ast, inputs } = e.data; self.postMessage(inputs.map(row => evaluate(ast, row))); };`;
  const url = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
};
export function evaluateFormulaRows(
  ast: FormulaNode,
  inputs: Record<string, FormulaValue>[],
  signal?: AbortSignal,
  factory: FormulaWorkerFactory = createFormulaWorker,
): Promise<FormulaResult[]> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!inputs.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = factory();
    } catch (e) {
      reject(
        new Error(
          `Formula worker unavailable: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    let offset = 0;
    const results: FormulaResult[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const send = () => {
      if (Date.now() - started > 30000) {
        cleanup();
        reject(
          new Error(
            "Formula exceeded the 30-second processing budget. Reduce the row count or simplify the formula.",
          ),
        );
        return;
      }
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Formula timed out. Check the regex or reduce the row count.",
          ),
        );
      }, 2000);
      try {
        worker.postMessage({ ast, inputs: inputs.slice(offset, offset + 200) });
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      cleanup();
      reject(new Error("Formula worker failed."));
    };
    worker.onmessage = (event: MessageEvent<FormulaResult[]>) => {
      clearTimeout(timer);
      results.push(...event.data);
      offset += event.data.length;
      if (offset >= inputs.length) {
        cleanup();
        resolve(results);
      } else send();
    };
    send();
  });
}
