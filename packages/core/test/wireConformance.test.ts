// Conformance of the TypeScript wire to schema/query-wire.schema.json and the
// golden fixtures in schema/fixtures/wire (also decoded and re-encoded by the
// Go and Swift suites). Regenerate the builder fixtures after an intended
// change with: WIRE_FIXTURES_UPDATE=1 npx vitest run packages/core/test/wireConformance.test.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY, loadSchema, toDistinctRequestV3, toFieldStatsRequestV3, toQueryRequestV3, toRowRequestV3,
  type QueryCapabilitiesV3, type QueryState,
} from "../src/index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = path.join(root, "schema/fixtures/wire");
const schemaDocument = JSON.parse(readFileSync(path.join(root, "schema/query-wire.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
// The x- keywords configure the generators and are inert for validation.
for (const keyword of ["x-ts-name", "x-ts-type", "x-go-name", "x-go-type", "x-go-repr", "x-go-omit", "x-go-extra",
  "x-swift-name", "x-swift-type", "x-swift-repr", "x-swift-case", "x-swift-default", "x-swift-init"]) ajv.addKeyword(keyword);
ajv.addSchema(schemaDocument);
const validator = (def: string) => ajv.getSchema(`${schemaDocument.$id}#/$defs/${def}`)!;
const validate = (def: string, value: unknown) => {
  const check = validator(def);
  return check(value) ? [] : (check.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
};
const read = (kind: string, name: string) => readFileSync(path.join(fixtures, kind, name), "utf8");
const list = (kind: string) => readdirSync(path.join(fixtures, kind)).filter(name => name.endsWith(".json")).sort();
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const capabilities: QueryCapabilitiesV3 = {
  regexSourceFilters: true, regexAggregateExpressions: true, metricFilters: true, metricMinCount: true,
  metricMinCountMeasures: true, version: 3, groupedRows: true, calendarGrouping: true, calendarCycles: true,
  calendarGroupKeys: true, computedSourceFilters: true, regex: true, maxRows: 10000, maxGroups: 2000,
  maxPopulation: 250000, profile: "qt-fixture-v1",
};
const schema = loadSchema({
  name: "runs", idField: "id", defaultLimit: 25,
  fields: [
    { name: "id", label: "ID", type: "number", source: "backend" },
    { name: "at", label: "Time", type: "datetime", source: "backend" },
    { name: "name", label: "Name", type: "text", source: "backend" },
    { name: "amount", label: "Amount", type: "number", source: "backend" },
    { name: "status", label: "Status", type: "enum", source: "backend", filter: { values: { source: "static", options: ["new", "done"] } } },
    { name: "tags", label: "Tags", type: "textarray", source: "backend" },
  ],
});
const now = 1772964000123;
const execution = { profile: "qt-fixture-v1", planToken: "plan-7", resolvedRevisions: { margin: "r3" }, fields: {}, snapshot: "s-42" };
const rowsQuery: QueryState = {
  ...EMPTY_QUERY,
  select: [{ field: "name" }, { field: "amount" }, { field: "status" }],
  where: [
    { field: "status", op: "=", value: "done" },
    { field: "name", op: "contains", value: "caf", negated: true },
    { any: [{ field: "amount", op: ">=", value: "10" }, { field: "at", op: ">=", value: "-7d" }] },
  ],
  orderBy: [{ field: "amount", dir: "desc", nulls: "first" }, { field: "name", dir: "asc", extract: { regex: "^(\\w+)" } }],
  limit: 50,
  offset: 100,
};
const hostState = { version: 1, params: { keyword: ["cache"] } };
/** Requests built by the TypeScript builders, which must equal their fixtures byte for byte. */
const built: Record<string, () => unknown> = {
  "rows.json": () => toQueryRequestV3(rowsQuery, schema, capabilities, execution, { now }),
  "distinct.json": () => toDistinctRequestV3("status", "do", capabilities, { now, limit: 30, hostState,
    where: [{ field: "amount", op: ">", value: "0" }] }),
  "row-lookup.json": () => toRowRequestV3(schema, 17, capabilities, { now, select: ["name", "amount"] }),
  "field-stats.json": () => toFieldStatsRequestV3(schema, ["amount", "name"], capabilities, { now }),
};

describe("wire schema conformance", () => {
  it("compiles the schema", () => {
    expect(validator("QueryRequestV3")).toBeTypeOf("function");
    expect(validator("QueryResultV3")).toBeTypeOf("function");
  });

  it.each(Object.keys(built))("builder output %s equals its fixture", (name) => {
    const text = serialize(built[name]!());
    if (process.env.WIRE_FIXTURES_UPDATE) writeFileSync(path.join(fixtures, "requests", name), text);
    expect(validate("QueryRequestV3", JSON.parse(text))).toEqual([]);
    expect(read("requests", name)).toBe(text);
  });

  it.each(list("requests"))("request fixture %s validates", (name) => {
    const text = read("requests", name);
    expect(validate("QueryRequestV3", JSON.parse(text))).toEqual([]);
    expect(serialize(JSON.parse(text)), "fixtures are formatted as JSON.stringify(value, null, 2)").toBe(text);
  });

  it.each(list("results"))("result fixture %s validates", (name) => {
    const text = read("results", name);
    expect(validate("QueryResultV3", JSON.parse(text))).toEqual([]);
    expect(serialize(JSON.parse(text))).toBe(text);
  });

  it("validates the capabilities fixture", () => {
    expect(validate("QueryCapabilitiesV3", capabilities)).toEqual([]);
  });

  it("validates builder outputs across query shapes", () => {
    const metricsQuery: QueryState = {
      ...EMPTY_QUERY,
      aggregations: [
        { id: "by-month", op: "sum", field: "amount", groupBy: ["at"], minCount: 2,
          dateGrouping: { field: "at", interval: "month", timeZone: "Europe/Berlin", includeEmpty: true, range: "observed" } },
        { id: "filtered", op: "count", groupBy: ["status"], where: [{ field: "amount", op: ">", value: "5" }],
          minCount: { min: 2, distinct: "name" } },
        { id: "box", op: "count", groupBy: ["status"], distribution: { kind: "box", input: "amount", whiskers: "tukey" } },
      ],
    };
    const groupedQuery = toQueryRequestV3({ ...rowsQuery, grouping: {
      keys: ["status", { field: "at", interval: "month" }],
      summaries: [{ id: "total", op: "sum", field: "amount" }], representative: null,
      source: { ...rowsQuery },
    } } as QueryState, schema, capabilities, undefined, { now });
    for (const request of [
      toQueryRequestV3(EMPTY_QUERY, schema, capabilities),
      toQueryRequestV3(metricsQuery, schema, capabilities, execution, { now, rows: false }),
      toQueryRequestV3(rowsQuery, schema, capabilities, undefined, { now }),
      groupedQuery,
      toDistinctRequestV3("tags", "", capabilities),
      toRowRequestV3(schema, "a-1", capabilities, { hostState }),
      toFieldStatsRequestV3(schema, ["amount", "at", "status"], capabilities),
    ]) expect(validate("QueryRequestV3", JSON.parse(JSON.stringify(request))), JSON.stringify(request)).toEqual([]);
  });

  it("rejects requests the schema forbids", () => {
    const request = JSON.parse(read("requests", "rows.json"));
    expect(validate("QueryRequestV3", { ...request, extra: true })).not.toEqual([]);
    expect(validate("QueryRequestV3", { ...request, source: { ...request.source, hostState } })).not.toEqual([]);
    expect(validate("QueryRequestV3", { ...request, metrics: [{ id: "m", op: "median", groupBy: [] }] })).not.toEqual([]);
    expect(validate("QueryRequestV3", { ...request, version: 2 })).not.toEqual([]);
  });
});
