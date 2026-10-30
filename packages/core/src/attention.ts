import { isJsonPath } from "./jsonInspection";
import type { RowId } from "./query";

/** Semantic identities only. A missing path never resolves to its parent. */
export interface AttentionTarget { dataset: string; rowId?: RowId; field?: string; path?: string }
export type AttentionResult = { status: "revealed" | "unavailable" | "cancelled"; target: AttentionTarget };
export interface AttentionProvider {
  /** Await data/layout readiness; observe cancellation before changing presentation. */
  ready?: (signal: AbortSignal) => Promise<void>;
  /** Load/open the exact record or property, then return whether it exists. */
  materialize?: (target: AttentionTarget, signal: AbortSignal) => boolean | Promise<boolean>;
  /** Scroll/highlight the materialized target. Must never move keyboard focus. */
  reveal: (target: AttentionTarget, signal: AbortSignal) => boolean | Promise<boolean>;
}
export interface AttentionRegistry {
  cancel(): void;
  register(target: AttentionTarget, provider: AttentionProvider): () => void;
  /** New navigation cancels the previous request; registrations alone never scroll. */
  resolve(target: AttentionTarget, options?: { signal?: AbortSignal }): Promise<AttentionResult>;
  /** For materializers awaiting a React commit or a virtualized row. */
  whenRegistered(target: AttentionTarget, signal: AbortSignal, except?: AttentionProvider): Promise<AttentionProvider>;
}
function validTarget(target: AttentionTarget): boolean {
  return typeof target.dataset === "string" && target.dataset.length > 0 && target.dataset.length <= 256
    && (target.rowId === undefined || (typeof target.rowId === "string" && target.rowId.length > 0 && target.rowId.length <= 1000)
      || (typeof target.rowId === "number" && Number.isFinite(target.rowId)))
    && (target.field === undefined || (target.rowId !== undefined && typeof target.field === "string" && target.field.length > 0 && target.field.length <= 256))
    && (target.path === undefined || (target.field !== undefined && isJsonPath(target.path)));
}
export function attentionTargetKey(target: AttentionTarget): string {
  return JSON.stringify([target.dataset, target.rowId ?? null, target.field ?? null, target.path ?? null]);
}
const cancelled = () => new Error("Attention navigation cancelled.");
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) { reject(cancelled()); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
/** Framework-independent registration and cancellation; adapters own materialization. */
export function createAttentionRegistry(): AttentionRegistry {
  const providers = new Map<string, AttentionProvider[]>();
  const listeners = new Set<() => void>();
  let current: AbortController | undefined;
  const lookup = (target: AttentionTarget) => providers.get(attentionTargetKey(target))?.slice(-1)[0];
  return {
    cancel() { current?.abort(); current = undefined; },
    register(target, provider) {
      if (!validTarget(target)) throw Error("Invalid semantic attention target.");
      const key = attentionTargetKey(target);
      const entries = providers.get(key) ?? [];
      providers.set(key, [...entries, provider]);
      listeners.forEach(listener => listener());
      return () => {
        const remaining = providers.get(key)?.filter(entry => entry !== provider) ?? [];
        if (remaining.length) providers.set(key, remaining); else providers.delete(key);
      };
    },
    whenRegistered(target, signal, except) {
      return new Promise((resolve, reject) => {
        const cleanup = () => { listeners.delete(check); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(cancelled()); };
        const check = () => { const provider = lookup(target); if (provider && provider !== except) { cleanup(); resolve(provider); } };
        if (signal.aborted) { reject(cancelled()); return; }
        listeners.add(check); signal.addEventListener("abort", abort, { once: true }); check();
      });
    },
    async resolve(target, options) {
      current?.abort();
      const controller = new AbortController(); current = controller;
      const signal = controller.signal;
      const abort = () => controller.abort();
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) controller.abort();
      const result = (status: AttentionResult["status"]): AttentionResult => ({ status, target });
      try {
        if (signal.aborted) return result("cancelled");
        if (!validTarget(target)) return result("unavailable");
        const candidates = [target,
          { dataset: target.dataset, ...(target.rowId !== undefined ? { rowId: target.rowId } : {}), ...(target.field !== undefined ? { field: target.field } : {}) },
          { dataset: target.dataset, ...(target.rowId !== undefined ? { rowId: target.rowId } : {}) },
          { dataset: target.dataset }];
        const provider = candidates.map(lookup).find(Boolean);
        if (!provider) return result("unavailable");
        if (provider.ready) await abortable(provider.ready(signal), signal);
        if (provider.materialize && !await abortable(Promise.resolve(provider.materialize(target, signal)), signal)) return result("unavailable");
        if (signal.aborted) return result("cancelled");
        const revealed = await abortable(Promise.resolve(provider.reveal(target, signal)), signal);
        return result(signal.aborted ? "cancelled" : revealed ? "revealed" : "unavailable");
      } catch (error) {
        if (signal.aborted) return result("cancelled");
        throw error;
      } finally { options?.signal?.removeEventListener("abort", abort); if (current === controller) current = undefined; }
    },
  };
}
