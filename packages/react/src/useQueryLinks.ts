import { useCallback, useEffect, useRef, useState } from "react";
import { encodeQuery, type QueryLink, type QueryLinkService, type QueryState, type QuerySnapshot } from "@pythia-software/query-table-core";

export interface QueryLinksApi {
  maxUrlBytes: number;
  kind: QueryLink["kind"] | null;
  busy: boolean;
  error: Error | null;
  /** Explicit Share/Bookmark: server snapshot if configured, otherwise a fitting inline link. */
  create(query?: QueryState, options?: { baseUrl?: string; parameter?: string }): Promise<QueryLink>;
  /** Synchronous local-only URL for navigation, never a server write. */
  local(query: QueryState, baseUrl?: string, parameter?: string): QueryLink;
  /** Save uses the same immutable snapshot and promotion path as Share. */
  snapshot(query: QueryState): Promise<QuerySnapshot | null>;
}

export function useQueryLinks(query: QueryState, service: QueryLinkService, syncUrl: boolean, ready: boolean, parameter: string, maxUrlBytes: number,
  onUrlChange: (url: string) => void): QueryLinksApi {
  const latest = useRef(query); latest.current = query;
  const [kind, setKind] = useState<QueryLink["kind"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const operations = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    if (!syncUrl || !ready || typeof window === "undefined") return;
    try {
      // Preserve an already-promoted link until the query actually changes.
      const result = service.local(query, window.location.href, parameter);
      window.history.replaceState(window.history.state, "", result.url);
      onUrlChange(result.url);
      setKind(result.kind); setError(null);
    } catch (e) { setError(e instanceof Error ? e : Error(String(e))); }
  }, [queryKey, syncUrl, ready, service, parameter, onUrlChange]);

  const snapshot = useCallback(async (q: QueryState) => {
    const captured = encodeQuery(q);
    const base = typeof window !== "undefined" ? window.location.href : undefined;
    operations.current++; setBusy(true); setError(null);
    try {
      if (!ready) throw Error("Resolve or reset the query link before saving it.");
      const saved = await service.snapshot(q);
      if (saved && base && mounted.current && syncUrl && ready && window.location.href === base && encodeQuery(latest.current) === captured) {
        const url = new URL(base); url.searchParams.set(parameter, "@" + saved.code);
        const result = service.local(q, url.toString(), parameter);
        window.history.replaceState(window.history.state, "", result.url); onUrlChange(result.url); setKind("durable");
      }
      return saved;
    }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e : Error(String(e))); throw e; }
    finally { operations.current--; if (mounted.current) setBusy(operations.current > 0); }
  }, [service, syncUrl, ready, parameter, onUrlChange]);
  const create = useCallback(async (q = latest.current, options: { baseUrl?: string; parameter?: string } = {}) => {
    const baseUrl = options.baseUrl ?? window.location.href;
    const param = options.parameter ?? parameter;
    const captured = encodeQuery(q);
    operations.current++; setBusy(true); setError(null);
    try {
      if (!ready) throw Error("Resolve or reset the query link before sharing it.");
      const result = await service.durable(q, baseUrl, param);
      if (mounted.current && syncUrl && ready && param === parameter &&
        window.location.href === baseUrl && encodeQuery(latest.current) === captured) {
        window.history.replaceState(window.history.state, "", result.url);
        onUrlChange(result.url);
        setKind(result.kind);
      }
      return result;
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e : Error(String(e))); throw e; }
    finally { operations.current--; if (mounted.current) setBusy(operations.current > 0); }
  }, [service, syncUrl, ready, parameter, onUrlChange]);
  const local = useCallback((q: QueryState, base = window.location.href, param = parameter) => service.local(q, base, param), [service, parameter]);
  return { maxUrlBytes, kind, busy, error, create, local, snapshot };
}
