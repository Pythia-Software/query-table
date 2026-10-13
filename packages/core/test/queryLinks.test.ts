import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "fflate";
import {
  createQueryLinkService, localQuerySnapshotCache, memoryQuerySnapshotCache,
  encodeQuery, decodeQueryStrict, EMPTY_QUERY, createSetFilter, queriesEqual,
  MAX_QUERY_STATE_BYTES, httpQuerySnapshotStore,
  type QuerySnapshot, type QuerySnapshotStore, type QueryState,
} from "../src/index";

const base = "https://example.test/runs?section=recent#table";
const large = (value = "one"): QueryState => ({ ...EMPTY_QUERY,
  where: [{ field: "name", op: "contains", value: Array.from({ length: 200 }, (_, i) => `${value}-${i * 7919}`).join(",") }] });
function store() {
  const rows = new Map<string, QuerySnapshot>();
  const save = vi.fn(async (key: string, snapshot: QuerySnapshot) => {
    const old = rows.get(key + snapshot.code);
    if (old && old.token !== snapshot.token) throw Error("conflict");
    rows.set(key + snapshot.code, snapshot); return snapshot;
  });
  const resolve = vi.fn(async (key: string, code: string) => rows.get(key + code) ?? null);
  return { save, resolve } satisfies QuerySnapshotStore;
}

describe("compact query codec", () => {
  it("packs set runs and identical modality views without changing meaning", () => {
    const view = { version: 1 as const, properties: [{ id: "p", field: "name", label: "Name" }] };
    const q: QueryState = { ...EMPTY_QUERY, where: createSetFilter("tags", "all", Array.from({length:50},(_,i)=>`key-${i}`), "set-1"),
      itemDetails: { modes: ["hover", "modal", "expand"], views: { hover: view, modal: view, expand: view } } };
    expect(encodeQuery(q).length).toBeLessThan(700);
    expect(queriesEqual(decodeQueryStrict(encodeQuery(q)), q)).toBe(true);
    q.where[2] = { field: "tags", op: "includes", value: "altered" };
    expect(queriesEqual(decodeQueryStrict(encodeQuery(q)), q)).toBe(true);
  });
  it("preserves Unicode and chooses plain encoding for tiny views", () => {
    expect(encodeQuery(EMPTY_QUERY)).toMatch(/^2j\./);
    const q = { ...EMPTY_QUERY, where: [{ field: "名", op: "=" as const, value: "😀 中文 é" }] };
    expect(decodeQueryStrict(encodeQuery(q))).toEqual(q);
    expect(decodeQueryStrict(Buffer.from('{"l":25}').toString("base64url")).limit).toBe(25);
    const formerlyOversized: QueryState = { ...EMPTY_QUERY, where: Array.from({length:100}, () => ({field:"name",op:"=" as const,value:"😀".repeat(5000)})) };
    expect(queriesEqual(decodeQueryStrict(encodeQuery(formerlyOversized)), formerlyOversized)).toBe(true);
  });
  it("fails explicitly on invalid versions and bounds expanded compressed state", () => {
    expect(() => decodeQueryStrict("3j.e30")).toThrow("Unsupported");
    expect(() => decodeQueryStrict("2j.bnVsbA")).toThrow("Invalid");
    expect(() => decodeQueryStrict("2d.AA")).toThrow();
    const bomb = "2d." + Buffer.from(deflateSync(new Uint8Array(MAX_QUERY_STATE_BYTES + 1).fill(120))).toString("base64url");
    expect(() => decodeQueryStrict(bomb)).toThrow("Expanded query state exceeds");
  });
  it("works with a Buffer polyfill that supports only ordinary base64", () => {
    const NativeBuffer = Buffer;
    const from = vi.fn((value: string | Uint8Array, encoding?: BufferEncoding) => ({
      toString(format: string) {
        if (format === "base64url") throw Error("Unknown encoding: base64url");
        return NativeBuffer.from(value as string, encoding).toString(format as BufferEncoding);
      },
    }));
    vi.stubGlobal("Buffer", { from });
    try {
      const q = large(); const token = encodeQuery(q);
      expect(token).toMatch(/^2d\./);
      expect(decodeQueryStrict(token)).toEqual(q);
      expect(from).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("local query links and explicit promotion", () => {
  it("keeps ordinary navigation local and promotes the same immutable code on Share", async () => {
    const remote = store(); const cache = memoryQuerySnapshotCache();
    const service = createQueryLinkService("runs", remote, { cache, maxUrlBytes: 160 });
    const local = service.local(large(), base);
    expect(local.kind).toBe("local"); expect(local.bytes).toBeLessThanOrEqual(160);
    expect(new URL(local.url).hash).toBe("#table");
    expect(new URL(local.url).searchParams.get("section")).toBe("recent");
    expect(await service.resolve(local.url)).toEqual(large());
    expect(remote.save).not.toHaveBeenCalled(); expect(remote.resolve).not.toHaveBeenCalled();
    const permanent = await service.durable(large(), local.url);
    expect(permanent.snapshotCode).toBe(local.snapshotCode); expect(permanent.kind).toBe("durable");
    await service.durable(large(), base);
    expect(remote.save).toHaveBeenCalledTimes(1);
    expect(service.local(large(), permanent.url).kind).toBe("durable");
    const otherDevice = createQueryLinkService("runs", remote, { cache: memoryQuerySnapshotCache() });
    expect(await otherDevice.resolve(permanent.url)).toEqual(large());
    expect(remote.resolve).toHaveBeenCalledOnce();
    const sameProfile = createQueryLinkService("runs", remote, { cache, maxUrlBytes:160 });
    expect(await sameProfile.resolve(permanent.url)).toEqual(large());
    expect(sameProfile.local(large(), permanent.url).kind).toBe("durable");
    expect(service.local(large("two"), local.url).snapshotCode).not.toBe(local.snapshotCode);
  });
  it("always snapshots explicit shares when a server is configured, even tiny views", async () => {
    const remote = store(); const service = createQueryLinkService("runs", remote, { cache: memoryQuerySnapshotCache() });
    expect(service.local(EMPTY_QUERY, base).kind).toBe("inline");
    expect((await service.durable(EMPTY_QUERY, base)).kind).toBe("durable");
    expect(remote.save).toHaveBeenCalledOnce();
  });
  it("evicts FIFO entries, scopes by dataset, and fails instead of restoring defaults", async () => {
    let text: string | null = null;
    const cache = localQuerySnapshotCache({ maxEntries: 2, storage: { getItem: () => text, setItem: (_, v) => { text = v; } } });
    const service = createQueryLinkService("runs", undefined, { cache, maxUrlBytes: 160 });
    const first = service.local(large("first"), base);
    const second = service.local(large("second"), base);
    service.local(large("third"), base);
    await expect(service.resolve(first.url)).rejects.toThrow("unavailable");
    expect(await service.resolve(second.url)).toEqual(large("second"));
    const other = createQueryLinkService("other", undefined, { cache });
    await expect(other.resolve(second.url)).rejects.toThrow("unavailable");
    await expect(service.resolve(base + "&q=x")).resolves.toBeNull(); // parameter in fragment is not a query
    await expect(service.resolve("https://example.test/?q=x&q=y")).rejects.toThrow("conflicting");
  });
  it("reports full URL/cache quota failure and never emits a local-only share", async () => {
    const cache = localQuerySnapshotCache({ storage: { getItem: () => null, setItem: () => { throw Error("quota exhausted"); } } });
    const service = createQueryLinkService("runs", undefined, { cache, maxUrlBytes: 160 });
    expect(() => service.local(large(), base)).toThrow("quota exhausted");
    await expect(service.durable(large(), base)).rejects.toThrow("URL budget");
    expect(() => createQueryLinkService("runs", undefined, {maxUrlBytes:10}).local(EMPTY_QUERY,base)).toThrow("URL budget");
  });
  it("ignores a single empty query value but rejects duplicate parameters", async () => {
    const service = createQueryLinkService("runs", undefined, { cache: memoryQuerySnapshotCache() });
    await expect(service.resolve("https://example.test/?q=")).resolves.toBeNull();
    await expect(service.resolve("https://example.test/?q=&q=")).rejects.toThrow("conflicting");
    await expect(service.resolve("https://example.test/?q=&q=" + encodeQuery(EMPTY_QUERY))).rejects.toThrow("conflicting");
  });
  it("retains the promotion code across failed retries even without localStorage", async () => {
    const remote = store(); remote.save.mockRejectedValueOnce(Error("offline"));
    const cache = { get: () => null, find: () => null, put: () => { throw Error("disabled"); } };
    const service = createQueryLinkService("runs", remote, { cache });
    await expect(service.snapshot(large())).rejects.toThrow("offline");
    await service.snapshot(large());
    expect(remote.save.mock.calls[0]![1].code).toBe(remote.save.mock.calls[1]![1].code);
  });
  it("persists HTTP snapshots by code and validates response identity", async () => {
    const snapshot: QuerySnapshot = { version:1, code:"a".repeat(22), token:encodeQuery(EMPTY_QUERY), createdAt:1 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot)));
    const remote = httpQuerySnapshotStore("/snapshots", fetcher);
    expect(await remote.save("runs", snapshot)).toEqual(snapshot);
    expect(fetcher.mock.calls[0]![0]).toBe("/snapshots?dataset=runs&code=" + snapshot.code);
    expect(fetcher.mock.calls[0]![1]?.method).toBe("PUT");
    fetcher.mockResolvedValueOnce(new Response(null, {status:404}));
    expect(await remote.resolve("runs", snapshot.code)).toBeNull();
  });
  it.each(["{broken", "null", "{}"])("recovers a corrupt cache envelope %s on the next write", async text => {
    const storage = { getItem: () => text, setItem: (_key: string, value: string) => { text = value; } };
    const cache = localQuerySnapshotCache({ storage });
    const service = createQueryLinkService("runs", undefined, { cache, maxUrlBytes:160 });
    const link = service.local(large(), base);
    expect(await service.resolve(link.url)).toEqual(large());
    expect(JSON.parse(text)).toHaveLength(1);
  });
  it("trims lowered entry/byte limits and replaces the over-limit envelope", () => {
    let text = "";
    const storage = { getItem: () => text, setItem: (_key: string, value: string) => { text = value; } };
    const original = localQuerySnapshotCache({storage,maxEntries:4});
    const snapshots = Array.from({length:4},(_,i): QuerySnapshot => ({version:1,code:String(i).repeat(22),token:encodeQuery({...EMPTY_QUERY,limit:i+1}),createdAt:i}));
    snapshots.forEach(snapshot => original.put("runs",snapshot));
    const limited = localQuerySnapshotCache({storage,maxEntries:2});
    expect(limited.get("runs",snapshots[0]!.code)).toBeNull();
    limited.put("runs",snapshots[3]!);
    expect(JSON.parse(text)).toHaveLength(2);
    const oneEntryBytes = JSON.stringify([JSON.parse(text)[1]]).length * 2;
    const smaller = localQuerySnapshotCache({storage,maxBytes:oneEntryBytes});
    expect(smaller.get("runs",snapshots[2]!.code)).toBeNull();
    smaller.put("runs",snapshots[3]!);
    expect(JSON.parse(text)).toHaveLength(1);
    expect(text.length * 2).toBeLessThanOrEqual(oneEntryBytes);
  });
});
