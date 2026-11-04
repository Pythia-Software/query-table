import { describe, expect, it, vi } from "vitest";
import {
  fetchDistinctValuesV3,
  fetchFieldStatsV3,
  fetchRowV3,
  normalizeQueryState,
  readDistinctResultV3,
  readFieldStatsResultV3,
  readRowResultV3,
  rowLookupFields,
  toDistinctRequestV3,
  toFieldStatsRequestV3,
  toQueryRequestV3,
  toRowRequestV3,
  validateQueryResultV3,
  type ComputedExecution,
  type QueryCapabilitiesV3,
  type QueryRequestV3,
  type QueryResultV3,
} from "../src/index";
import { runsSchema } from "./fixtures";

const capabilities: QueryCapabilitiesV3 = { version: 3, profile: "qt-test", groupedRows: true, calendarGrouping: true,
  computedSourceFilters: false, regex: false, maxRows: 100, maxGroups: 100, maxPopulation: 1000 };
const execution: ComputedExecution = { profile: "qt-test", planToken: "plan", snapshot: "s1", resolvedRevisions: { "@computed/x": "r1" }, fields: {} };
const response = (request: QueryRequestV3, part: Partial<QueryResultV3> = {}): QueryResultV3 => ({
  version: 3, now: request.now, sourceTotal: 0, rows: [], total: 0, metrics: [],
  schema: { name: "runs", idField: "id", fields: [] },
  execution: { profile: request.profile, planToken: request.planToken ?? "", resolvedRevisions: { ...request.expectedRevisions }, fields: {},
    ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}) }, ...part,
});
const stage = { select: [], where: [], orderBy: [], limit: 1, offset: 0 };

describe("distinct values", () => {
  it("asks for suggestions over the whole source, in the negotiated envelope", () => {
    const hostState = { version: 1, params: { k: ["v"] } };
    expect(toDistinctRequestV3("platform", "mac", capabilities, { now: 5, execution, hostState, limit: 20 })).toEqual({
      hostState, version: 3, profile: "qt-test", now: 5, expectedRevisions: { x: "r1" }, planToken: "plan", snapshot: "s1",
      source: stage, result: stage, rows: false, metrics: [], distinct: { field: "platform", search: "mac", limit: 20 },
    });
    expect(toDistinctRequestV3("platform", "", capabilities, { now: 5 }).distinct).toEqual({ field: "platform", search: "", limit: 50 });
    expect(toDistinctRequestV3("platform", "", capabilities, { now: 5, where: [{ field: "overall", op: "=", value: "FAIL" }] }).source.where)
      .toEqual([{ field: "overall", op: "=", value: "FAIL" }]);
  });
  it("diagnoses budgets and a mismatched profile before sending", () => {
    expect(() => toDistinctRequestV3("platform", "", capabilities, { limit: 0 })).toThrow(/between 1 and 500/);
    expect(() => toDistinctRequestV3("platform", "", capabilities, { limit: 501 })).toThrow(/between 1 and 500/);
    expect(() => toDistinctRequestV3("platform", "x".repeat(2001), capabilities)).toThrow(expect.objectContaining({ code: "invalid_query", message: "Distinct search exceeds its budget." }));
    expect(() => toDistinctRequestV3("platform", "", capabilities, { execution: { ...execution, profile: "other" } }))
      .toThrow(expect.objectContaining({ code: "profile_mismatch", message: "The negotiated query profile is unavailable." }));
  });
  it("validates the distinct section of a response", () => {
    const request = toDistinctRequestV3("platform", "", capabilities, { now: 5, limit: 2 });
    const ok = { values: ["macos", "windows"], hasMore: true, hasNull: false };
    expect(readDistinctResultV3(response(request, { distinct: ok }), request, runsSchema)).toEqual(ok);
    for (const distinct of [undefined, { ...ok, values: ["a", "b", "c"] }, { ...ok, values: [1] }, { ...ok, hasNull: undefined }, { ...ok, hasMore: "no" }])
      expect(() => readDistinctResultV3(response(request, { distinct } as never), request, runsSchema)).toThrow("Invalid distinct values response.");
    expect(() => validateQueryResultV3(response(request, { distinct: ok, now: 6 }), request, runsSchema)).toThrow("mismatched");
  });
  it("fetches through the transport and refuses diagnosed requests", async () => {
    const fetchQueryV3 = vi.fn(async (request: QueryRequestV3) => response(request, { distinct: { values: ["macos"], hasMore: false, hasNull: true } }));
    const signal = new AbortController().signal;
    expect(await fetchDistinctValuesV3({ queryCapabilities: capabilities, fetchQueryV3 }, runsSchema, "platform", "m", { now: 5 }, signal))
      .toEqual({ values: ["macos"], hasMore: false, hasNull: true });
    expect(fetchQueryV3).toHaveBeenCalledWith(expect.objectContaining({ distinct: { field: "platform", search: "m", limit: 50 } }), signal);
    await expect(fetchDistinctValuesV3({ queryCapabilities: capabilities, fetchQueryV3 }, runsSchema, "platform", "", { limit: 900 })).rejects.toThrow("between 1 and 500");
    expect(fetchQueryV3).toHaveBeenCalledOnce();
  });
});

describe("row lookups", () => {
  it("selects one identity with room to detect a duplicate", () => {
    const request = toRowRequestV3(runsSchema, 7, capabilities, { now: 5 });
    const lookup = { select: ["case_name", "error_codes", "id", "is_starred", "overall", "platform", "total_ms"],
      where: [{ field: "id", op: "=", value: "7" }], orderBy: [], limit: 2, offset: 0 };
    expect(request).toMatchObject({ rows: true, metrics: [], source: lookup, result: lookup });
    expect(rowLookupFields(runsSchema)).toEqual(lookup.select);
    expect(toRowRequestV3(runsSchema, "a", capabilities, { select: ["overall"] }).result.select).toEqual(["id", "overall"]);
  });
  it("reads none, one, or rejects two rows and a different identity", async () => {
    const request = toRowRequestV3(runsSchema, 7, capabilities, { now: 5 });
    const fields = runsSchema.fields.filter(field => field.source.kind === "backend").map(({ name, type }) => ({ name, type }));
    const result = (rows: Record<string, unknown>[]) => response(request, { rows, total: rows.length, schema: { name: "runs", idField: "id", fields } });
    expect(readRowResultV3(result([]), request, runsSchema)).toBeNull();
    expect(readRowResultV3(result([{ id: 7, overall: "PASS" }]), request, runsSchema)).toEqual({ id: 7, overall: "PASS" });
    expect(() => readRowResultV3(result([{ id: 7 }, { id: 8 }]), request, runsSchema)).toThrow("identity must be unique");
    expect(() => readRowResultV3(result([{ id: 8 }]), request, runsSchema)).toThrow("different row");
    const fetchQueryV3 = vi.fn(async () => result([{ id: 7 }]));
    expect(await fetchRowV3({ queryCapabilities: capabilities, fetchQueryV3 }, runsSchema, 7, { now: 5 })).toEqual({ id: 7 });
  });
});

describe("field statistics", () => {
  it("asks for distinct counts and the bounds each field allows", () => {
    const request = toFieldStatsRequestV3(runsSchema, ["total_ms", "is_starred", "error_codes", "details", "missing", "total_ms"], capabilities, { now: 5 });
    expect(request).toMatchObject({ rows: false, source: stage, result: stage });
    expect(request.metrics).toEqual([
      { id: "total_ms:distinct", op: "count_distinct", field: "total_ms", groupBy: [] },
      { id: "total_ms:min", op: "min", field: "total_ms", groupBy: [] },
      { id: "total_ms:max", op: "max", field: "total_ms", groupBy: [] },
      { id: "is_starred:distinct", op: "count_distinct", field: "is_starred", groupBy: [] },
    ]);
  });
  it("reads values, skipping failed and missing metrics", () => {
    const request = toFieldStatsRequestV3(runsSchema, ["total_ms", "overall"], capabilities, { now: 5 });
    const bucket = (value: number | string | null) => ({ keys: [], value, count: 4 });
    const result = response(request, { metrics: [
      { id: "total_ms:distinct", buckets: [bucket(3)] }, { id: "total_ms:min", buckets: [bucket(50)] }, { id: "total_ms:max", buckets: [], error: "boom" },
      { id: "overall:distinct", buckets: [bucket(2)] }, { id: "overall:min", buckets: [bucket("FAIL")] }, { id: "overall:max", buckets: [bucket(null)] },
    ] });
    expect(readFieldStatsResultV3(result, request, runsSchema)).toEqual({ total_ms: { distinct: 3, min: 50 }, overall: { distinct: 2, min: "FAIL" } });
  });
  it("batches metrics within the per-request budget", async () => {
    const fields = Array.from({ length: 8 }, (_, i) => ({ name: `n${i}`, label: `N${i}`, type: "number" as const, source: { kind: "backend" as const } }));
    const schema = { name: "runs", idField: "n0", fields };
    const fetchQueryV3 = vi.fn(async (request: QueryRequestV3) => response(request, { schema: { name: "runs", idField: "n0", fields: [] },
      metrics: request.metrics.map(metric => ({ id: metric.id, buckets: [{ keys: [], value: 1, count: 1 }] })) }));
    const stats = await fetchFieldStatsV3({ queryCapabilities: capabilities, fetchQueryV3 }, schema, fields.map(field => field.name), { now: 5 });
    expect(fetchQueryV3.mock.calls.map(([request]) => request.metrics.length)).toEqual([20, 4]);
    expect(stats).toEqual(Object.fromEntries(fields.map(field => [field.name, { distinct: 1, min: 1, max: 1 }])));
    expect(await fetchFieldStatsV3({ queryCapabilities: capabilities, fetchQueryV3 }, schema, [], { now: 5 })).toEqual({});
    expect(fetchQueryV3).toHaveBeenCalledTimes(2);
  });
});

describe("field statistics keyed by data", () => {
  it("keeps a field named __proto__ an own key without touching Object.prototype", () => {
    const schema = { ...runsSchema, fields: [...runsSchema.fields, { name: "__proto__", label: "Proto", type: "number" as const, source: { kind: "backend" as const } }] };
    const request = toFieldStatsRequestV3(schema, ["__proto__"], capabilities);
    const stats = readFieldStatsResultV3(response(request, { metrics: request.metrics.map(metric => ({ id: metric.id, buckets: [{ keys: [], value: 3, count: 1 }] })) }), request, schema);
    expect(Object.prototype.hasOwnProperty.call(stats, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stats, "__proto__")?.value).toEqual({ distinct: 3, min: 3, max: 3 });
    expect(({} as Record<string, unknown>).distinct).toBeUndefined();
  });
});

describe("identity lookups under a one-row budget", () => {
  it("stays within maxRows and still detects a duplicate identity by the total", () => {
    const tight = { ...capabilities, maxRows: 1 };
    const request = toRowRequestV3(runsSchema, "r1", tight);
    expect(request.result.limit).toBe(1);
    const row = { [runsSchema.idField]: "r1" };
    const projected = { schema: { name: "runs", idField: "id", fields: request.result.select.map(name => ({ name, type: runsSchema.fields.find(f => f.name === name)!.type })) } };
    expect(readRowResultV3(response(request, { ...projected, rows: [row], total: 1, sourceTotal: 1 }), request, runsSchema)).toEqual(row);
    expect(() => readRowResultV3(response(request, { ...projected, rows: [row], total: 2, sourceTotal: 2 }), request, runsSchema)).toThrow("Row identity must be unique.");
  });
});

describe("metrics this client cannot read", () => {
  it("refuses a placeholder op instead of running it", () => {
    // A newer client's operation decodes as count with the original kept aside.
    const query = normalizeQueryState({ aggregations: [{ id: "m", op: "future", groupBy: [] }] });
    expect(query.aggregations![0]).toMatchObject({ op: "count", unsupportedOp: "future" });
    expect(() => toQueryRequestV3(query, runsSchema, capabilities, undefined, { now: 1, rows: false }))
      .toThrow(expect.objectContaining({ code: "invalid_metric", metricId: "m", message: expect.stringContaining("Metric m uses an unsupported operation: future.") }));
  });
});
