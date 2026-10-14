import { decodeQueryStrict, encodeQuery } from "./encode";
import { MAX_QUERY_TOKEN_LENGTH, type QueryState } from "./query";

export interface QuerySnapshot {
  version: 1;
  code: string;
  token: string;
  createdAt: number;
}
/** The host owns authenticated, durable storage. Save is immutable/idempotent
 * by code: an existing code may never be assigned a different token. */
export interface QuerySnapshotStore {
  save(key: string, snapshot: QuerySnapshot, signal?: AbortSignal): Promise<QuerySnapshot>;
  resolve(key: string, code: string, signal?: AbortSignal): Promise<QuerySnapshot | null>;
}
export interface QuerySnapshotCache {
  get(key: string, code: string): QuerySnapshot | null;
  find(key: string, token: string): QuerySnapshot | null;
  put(key: string, snapshot: QuerySnapshot): void;
  isDurable?(key: string, code: string): boolean;
  markDurable?(key: string, code: string): void;
}
export interface QueryLink {
  url: string;
  kind: "inline" | "local" | "durable";
  bytes: number;
  snapshotCode?: string;
}
export interface QueryLinkOptions {
  /** Complete URL budget, including host parameters and fragment. Default 2000. */
  maxUrlBytes?: number;
  cache?: QuerySnapshotCache;
}
const codePattern = /^[A-Za-z0-9_-]{22}$/;
export function validateQuerySnapshot(input: unknown): QuerySnapshot {
  const s = input as QuerySnapshot;
  if (!s || s.version !== 1 || !codePattern.test(s.code) || typeof s.token !== "string" ||
    s.token.length > MAX_QUERY_TOKEN_LENGTH || !Number.isFinite(s.createdAt)) throw Error("Invalid query snapshot.");
  decodeQueryStrict(s.token);
  return { version: 1, code: s.code, token: s.token, createdAt: s.createdAt };
}
function newSnapshot(token: string): QuerySnapshot {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { version: 1, code: btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), token, createdAt: Date.now() };
}

/** FIFO entries are scoped by dataset. One bounded envelope makes each write
 * atomic; the new entry is protected from eviction and stored before URL use.
 * Browser profiles, origins, and devices do not share these entries. */
export function localQuerySnapshotCache(options: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  storageKey?: string;
  maxEntries?: number;
  maxBytes?: number;
} = {}): QuerySnapshotCache {
  const storageKey = options.storageKey ?? "query-table:link-cache:v1";
  const maxEntries = options.maxEntries ?? 100;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) throw Error("Invalid query link cache limits.");
  type Entry = { key: string; snapshot: QuerySnapshot; durable?: boolean };
  const storage = () => options.storage ?? globalThis.localStorage;
  function read(): Entry[] {
    const text = storage().getItem(storageKey);
    if (!text) return [];
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const entries: Entry[] = raw.filter(e => e && typeof e.key === "string" && e.snapshot &&
      e.snapshot.version === 1 && codePattern.test(e.snapshot.code) && typeof e.snapshot.token === "string" &&
      e.snapshot.token.length <= MAX_QUERY_TOKEN_LENGTH && Number.isFinite(e.snapshot.createdAt)).slice(-maxEntries);
    // A lowered host limit trims the oldest entries instead of poisoning the
    // cache. The next successful write replaces malformed/outdated envelopes.
    while (entries.length && JSON.stringify(entries).length * 2 > maxBytes) entries.shift();
    return entries;
  }
  return {
    isDurable(key, code) { return read().some(e => e.key === key && e.snapshot.code === code && e.durable); },
    markDurable(key, code) {
      const entries = read(); const entry = entries.find(e => e.key === key && e.snapshot.code === code);
      if (entry) {
        entry.durable = true;
        let text = JSON.stringify(entries);
        while (text.length * 2 > maxBytes && entries.length > 1) {
          entries.splice(entries[0] === entry ? 1 : 0, 1); text = JSON.stringify(entries);
        }
        if (text.length * 2 <= maxBytes) storage().setItem(storageKey, text);
      }
    },
    get(key, code) { return read().find(e => e.key === key && e.snapshot.code === code)?.snapshot ?? null; },
    find(key, token) { return read().find(e => e.key === key && e.snapshot.token === token)?.snapshot ?? null; },
    put(key, snapshot) {
      const entries = read();
      const old = entries.find(e => e.key === key && e.snapshot.code === snapshot.code);
      if (old) {
        if (old.snapshot.token !== snapshot.token) throw Error("A query link code cannot be overwritten.");
        const text = JSON.stringify(entries);
        if (storage().getItem(storageKey) !== text) storage().setItem(storageKey, text);
        return;
      }
      entries.push({ key, snapshot: validateQuerySnapshot(snapshot) });
      while (entries.length > maxEntries) entries.shift();
      let text = JSON.stringify(entries);
      // Web Storage stores UTF-16 strings; charge both bytes of each code unit.
      while (text.length * 2 > maxBytes && entries.length > 1) { entries.shift(); text = JSON.stringify(entries); }
      if (text.length * 2 > maxBytes) throw Error("This query is too large for the local link cache.");
      storage().setItem(storageKey, text); // Throws on quota/access failure; caller keeps the previous URL.
    },
  };
}

export function memoryQuerySnapshotCache(): QuerySnapshotCache {
  let text: string | null = null;
  return localQuerySnapshotCache({ storage: { getItem: () => text, setItem: (_key, value) => { text = value; } } });
}

export type QuerySnapshotHttpErrorCode = "quota" | "forbidden" | "conflict" | "unavailable" | "storage" | "http";

/** HTTP failures retain structured information for host error formatting. The
 * message is plain text suitable for displaying in the Save/Share UI. */
export class QuerySnapshotHttpError extends Error {
  readonly name = "QuerySnapshotHttpError";
  constructor(
    readonly status: number,
    readonly code: QuerySnapshotHttpErrorCode,
    message: string,
    readonly detail?: string,
    readonly serverCode?: string,
  ) { super(message); }
}

async function snapshotHttpError(response: Response): Promise<QuerySnapshotHttpError> {
  // Error endpoints may return plain text (including Go's http.Error), JSON,
  // HTML proxy pages, or arbitrarily large bodies. Read at most 4 KiB and never
  // turn an infrastructure response or HTML into a browser-facing message.
  let detail: string | undefined;
  let serverCode: string | undefined;
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (response.body && (type === "text/plain" || type === "application/json")) {
    const reader = response.body.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let complete = false;
      while (size <= 4096) {
        const next = await reader.read();
        if (next.done) { complete = true; break; }
        size += next.value.byteLength;
        if (size <= 4096) chunks.push(next.value);
      }
      if (complete) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const text = new TextDecoder().decode(bytes);
        let reason: unknown = text;
        if (type === "application/json") {
          const body = JSON.parse(text);
          reason = body?.message ?? body?.error?.message ?? body?.error;
          const code = body?.code ?? body?.error?.code;
          if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) serverCode = code;
        }
        if (typeof reason === "string" && !/[<>]/.test(reason)) {
          const safe = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
          if (safe) detail = safe.slice(0, 512);
        }
      }
    } catch { /* An unreadable error body must not hide the HTTP failure. */ }
    finally {
      try { await reader.cancel(); } catch { /* Already closed or disconnected. */ }
      reader.releaseLock();
    }
  }
  const status = response.status;
  const code: QuerySnapshotHttpErrorCode = status === 507 ? "quota" : status === 401 || status === 403 ? "forbidden"
    : status === 409 ? "conflict" : status === 404 ? "unavailable" : status >= 500 ? "storage" : "http";
  const messages: Record<QuerySnapshotHttpErrorCode, string> = {
    quota: "Query snapshot storage is full. Ask your host to increase its quota, then retry saving. Existing links still work.",
    forbidden: "You do not have permission to save or open this query link. Sign in or ask your host for access.",
    conflict: "This query link code already identifies different state. Ask your host to check its snapshot store.",
    unavailable: "This query link is unavailable. Check its address or ask its author for a new link.",
    storage: "Query snapshot storage is temporarily unavailable. Retry later; your previous saved query is unchanged.",
    http: `Query snapshot request failed (${status}). Check the request or retry later.`,
  };
  const message = messages[code] + (code !== "http" ? ` (HTTP ${status})` : "")
    + (detail && (status < 500 || status === 507) ? ` ${detail}` : "");
  return new QuerySnapshotHttpError(status, code, message, detail, serverCode);
}

export function httpQuerySnapshotStore(base: string, fetcher: typeof fetch = fetch): QuerySnapshotStore {
  const url = (key: string, code: string) => `${base}${base.includes("?") ? "&" : "?"}dataset=${encodeURIComponent(key)}&code=${encodeURIComponent(code)}`;
  async function responseSnapshot(response: Response): Promise<QuerySnapshot> {
    if (!response.ok) throw await snapshotHttpError(response);
    return validateQuerySnapshot(await response.json());
  }
  return {
    async save(key, snapshot, signal) {
      const result = await responseSnapshot(await fetcher(url(key, snapshot.code), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot), ...(signal ? { signal } : {}),
      }));
      if (result.code !== snapshot.code || result.token !== snapshot.token) throw Error("The snapshot store changed this immutable query link.");
      return result;
    },
    async resolve(key, code, signal) {
      const response = await fetcher(url(key, code), signal ? { signal } : {});
      if (response.status === 404) return null;
      const result = await responseSnapshot(response);
      if (result.code !== code) throw Error("The snapshot store returned a different query link.");
      return result;
    },
  };
}

export interface QueryLinkService {
  local(query: QueryState, baseUrl: string, parameter?: string): QueryLink;
  durable(query: QueryState, baseUrl: string, parameter?: string): Promise<QueryLink>;
  snapshot(query: QueryState): Promise<QuerySnapshot | null>;
  resolve(url: string, parameter?: string, signal?: AbortSignal): Promise<QueryState | null>;
}

/** Local URL synchronization never writes to the server. Only explicit
 * snapshot/durable calls (Save/Share/Bookmark) promote state to the host store. */
export function createQueryLinkService(key: string, store?: QuerySnapshotStore, options: QueryLinkOptions = {}): QueryLinkService {
  const budget = options.maxUrlBytes ?? 2000;
  if (!Number.isInteger(budget) || budget < 1) throw Error("Invalid query URL budget.");
  const cache = options.cache ?? localQuerySnapshotCache();
  const promoted = new Map<string, Promise<QuerySnapshot>>();
  const attempts = new Map<string, QuerySnapshot>();
  const known = new Map<string, QuerySnapshot>();
  function remember(snapshot: QuerySnapshot) {
    known.set(snapshot.code, snapshot);
    while (known.size > 100) known.delete(known.keys().next().value!);
    try { cache.put(key, snapshot); cache.markDurable?.(key, snapshot.code); } catch { /* Durable link does not require a cache. */ }
  }
  function link(base: string, parameter: string, value: string, kind: QueryLink["kind"]): QueryLink {
    const url = new URL(base);
    url.searchParams.set(parameter, value);
    const bytes = new TextEncoder().encode(url.toString()).length;
    if (bytes > budget) throw Error("The query link exceeds the URL budget, including the page address.");
    return { url: url.toString(), kind, bytes, ...(kind !== "inline" ? { snapshotCode: value.slice(1) } : {}) };
  }
  function cached(token: string): QuerySnapshot | null {
    try { return cache.find(key, token); } catch { return null; }
  }
  async function snapshot(query: QueryState): Promise<QuerySnapshot | null> {
    if (!store) return null;
    const token = encodeQuery(query);
    const existing = promoted.get(token);
    if (existing) return existing;
    const local = attempts.get(token) ?? cached(token) ?? newSnapshot(token);
    attempts.set(token, local);
    while (attempts.size > 100) attempts.delete(attempts.keys().next().value!);
    // Also retain the code after failed/uncertain writes, so retries are idempotent.
    try { cache.put(key, local); } catch { /* A durable store works without browser storage. */ }
    const pending = store.save(key, local).then(result => {
      const valid = validateQuerySnapshot(result);
      if (valid.code !== local.code || valid.token !== token) throw Error("The snapshot store changed this immutable query link.");
      remember(valid);
      return valid;
    });
    promoted.set(token, pending);
    while (promoted.size > 100) promoted.delete(promoted.keys().next().value!);
    try { return await pending; } catch (error) { promoted.delete(token); throw error; }
  }
  return {
    local(query, baseUrl, parameter = "q") {
      const token = encodeQuery(query);
      const current = new URL(baseUrl).searchParams.get(parameter);
      if (current?.startsWith("@") && known.get(current.slice(1))?.token === token)
        return link(baseUrl, parameter, current, "durable");
      if (current?.startsWith("@")) {
        try {
          const code = current.slice(1);
          if (cache.isDurable?.(key, code) && cache.get(key, code)?.token === token)
            return link(baseUrl, parameter, current, "durable");
        } catch { /* Try ordinary inline/local materialization next. */ }
      }
      const url = new URL(baseUrl); url.searchParams.set(parameter, token);
      if (new TextEncoder().encode(url.toString()).length <= budget) return link(baseUrl, parameter, token, "inline");
      const local = cached(token) ?? newSnapshot(token);
      const result = link(baseUrl, parameter, "@" + local.code, "local");
      cache.put(key, local);
      return result;
    },
    async durable(query, baseUrl, parameter = "q") {
      const saved = await snapshot(query);
      if (saved) return link(baseUrl, parameter, "@" + saved.code, "durable");
      const token = encodeQuery(query);
      // Small inline links are portable without a server; never share a local-only code.
      return link(baseUrl, parameter, token, "inline");
    },
    snapshot,
    async resolve(baseUrl, parameter = "q", signal) {
      const values = new URL(baseUrl).searchParams.getAll(parameter);
      if (!values.length || (values.length === 1 && values[0] === "")) return null;
      if (values.length !== 1) throw Error("Invalid or conflicting query link parameters.");
      const value = values[0]!;
      if (!value.startsWith("@")) return decodeQueryStrict(value);
      const code = value.slice(1);
      if (!codePattern.test(code)) throw Error("Invalid query link code.");
      let local: QuerySnapshot | null = null;
      try { local = cache.get(key, code); if (local) local = validateQuerySnapshot(local); } catch { local = null; }
      const result = local ?? (store ? await store.resolve(key, code, signal) : null);
      if (!result) throw Error("This query link is unavailable. Its local cache entry may have expired; use a saved or shared link for permanent access.");
      const valid = validateQuerySnapshot(result);
      if (valid.code !== code) throw Error("Invalid query snapshot code.");
      if (!local) remember(valid);
      else { try { if (cache.isDurable?.(key, code)) remember(valid); } catch { /* Cache metadata is optional. */ } }
      return decodeQueryStrict(valid.token);
    },
  };
}
