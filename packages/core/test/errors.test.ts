import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY, QueryDecodeError, QueryError, decodeQueryStrict, errorCodeForStatus, evaluateMetrics, isErrorCode, isQueryError, loadSchema, queryErrorFromBody,
  httpComputedColumnStore, queryErrorFromResponse, toQueryRequestV3, type QueryCapabilitiesV3,
} from "../src/index";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("QueryError", () => {
  it("keeps its code and details", () => {
    const error = new QueryError("syntax", "expected )", { field: "@computed/a", offset: 3, status: 400 });
    expect(error).toBeInstanceOf(Error);
    expect(isQueryError(error)).toBe(true);
    expect(isQueryError(new Error("x"))).toBe(false);
    expect(error).toMatchObject({ name: "QueryError", code: "syntax", message: "expected )", field: "@computed/a", offset: 3, status: 400 });
    expect(error.toJSON()).toEqual({ code: "syntax", message: "expected )", field: "@computed/a", offset: 3 });
    expect(isErrorCode("resource_limit")).toBe(true);
    expect(isErrorCode("no_such_code")).toBe(false);
  });

  it("is the base of query link decode errors", () => {
    let error: unknown;
    try { decodeQueryStrict("not a query"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(QueryDecodeError);
    expect(isQueryError(error) && error.code).toBe("invalid");
  });

  it("reads a QueryErrorBody from a response", async () => {
    const error = await queryErrorFromResponse(json({ error: { code: "resource_limit", message: "too many groups", metricId: "m" } }, 422));
    expect(error).toMatchObject({ code: "resource_limit", message: "too many groups", metricId: "m", status: 422 });
    // A newer server code is kept as a string.
    expect((await queryErrorFromResponse(json({ error: { code: "brand_new", message: "later" } }, 400))).code).toBe("brand_new");
  });

  it("falls back to a code from the status", async () => {
    const proxy = await queryErrorFromResponse(new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect(proxy).toMatchObject({ code: "unavailable", status: 502, message: "Request failed with HTTP 502 Bad Gateway." });
    expect(await queryErrorFromResponse(new Response("forbidden\n", { status: 403 }))).toMatchObject({ code: "forbidden", message: "forbidden" });
    expect(await queryErrorFromResponse(json({ error: "legacy text" }, 500))).toMatchObject({ code: "internal", message: "legacy text" });
    expect([400, 404, 405, 408, 409, 413, 422, 504, 507, 500].map(errorCodeForStatus)).toEqual([
      "invalid_request", "not_found", "method_not_allowed", "cancelled", "conflict", "request_too_large", "resource_limit", "timeout", "quota_exceeded", "internal",
    ]);
  });

  it("is thrown by the request builders before anything is sent", () => {
    const schema = loadSchema({ name: "runs", idField: "id", fields: [
      { name: "id", label: "ID", type: "text", source: "backend" },
      { name: "kind", label: "Kind", type: "enum", source: "backend", filter: { values: { source: "static", options: ["a"] } } },
    ] });
    const capabilities: QueryCapabilitiesV3 = { version: 3, profile: "p", groupedRows: false, calendarGrouping: false,
      computedSourceFilters: false, regex: false, maxRows: 100, maxGroups: 100, maxPopulation: 100 };
    const grouped = { ...EMPTY_QUERY, grouping: { keys: ["kind"], summaries: [], representative: null, source: EMPTY_QUERY } };
    let error: unknown;
    try { toQueryRequestV3(grouped, schema, capabilities); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toMatchObject({ code: "capability_unsupported", capability: "groupedRows" });
    expect(() => toQueryRequestV3(EMPTY_QUERY, schema, capabilities, { profile: "other", planToken: "", resolvedRevisions: {}, fields: {} }))
      .toThrow(expect.objectContaining({ code: "profile_mismatch" }));
    expect(toQueryRequestV3(EMPTY_QUERY, schema, capabilities)).not.toHaveProperty("diagnostics");
  });
});

describe("httpComputedColumnStore", () => {
  const column = { id: "a", label: "A", expression: { language: "qt-expr" as const, version: 1 as const, source: "[n]" } };
  it("keeps the server's code, field and status", async () => {
    const store = httpComputedColumnStore("/computed", async () =>
      json({ error: { code: "syntax", message: "expected )", field: "@computed/a" } }, 400));
    await expect(store.save("runs", column, null)).rejects.toMatchObject({ code: "syntax", field: "@computed/a", status: 400, message: "expected )" });
  });
  it("reads a stale revision as a reload prompt with its code", async () => {
    const store = httpComputedColumnStore("/computed", async () =>
      json({ error: { code: "conflict", message: "revision mismatch" } }, 409));
    const error = await store.save("runs", column, "r1").catch((e: unknown) => e);
    expect(isQueryError(error) && [error.code, error.status, error.message])
      .toEqual(["conflict", 409, "This definition changed. Reload it before saving again."]);
  });
});

describe("local metric failures", () => {
  const schema = { name: "runs", idField: "id", fields: [
    { name: "id", label: "ID", type: "number" as const, source: { kind: "backend" as const } },
    { name: "name", label: "Name", type: "text" as const, source: { kind: "backend" as const } },
  ] };
  const rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
  it("carries a code like the server's", () => {
    const invalid = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [{ id: "bad", op: "sum", field: "name", groupBy: [] }] }, schema);
    expect(invalid.metrics[0]).toMatchObject({ id: "bad", errorCode: "invalid_metric" });
    const budget = evaluateMetrics(rows, { ...EMPTY_QUERY, aggregations: [{ id: "n", op: "count", groupBy: [] }] }, schema, { maxRows: 1 });
    expect(budget.metrics[0]).toMatchObject({ id: "n", error: "Metric row budget exceeded.", errorCode: "resource_limit" });
  });
});

describe("codes from newer servers", () => {
  it("keeps an unknown code as a string a client can narrow", () => {
    const error = queryErrorFromBody({ error: { code: "from_the_future", message: "newer" } }, 400)!;
    expect(error.code).toBe("from_the_future");
    expect(isErrorCode(error.code)).toBe(false);
    const known: string = error.code;
    expect(known).toBe("from_the_future");
  });
});
