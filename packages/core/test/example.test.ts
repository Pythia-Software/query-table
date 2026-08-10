import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSchema, selectedFields } from "../src/index";

// Loads the shipped example document end-to-end through the real loader, so the
// example, the meta-schema, and loadSchema can never silently drift.
const docPath = fileURLToPath(new URL("../../../schema/examples/runs.schema.json", import.meta.url));
const doc = JSON.parse(readFileSync(docPath, "utf8"));

describe("schema/examples/runs.schema.json", () => {
  it("loads through loadSchema", () => {
    const s = loadSchema(doc);
    expect(s.name).toBe("runs");
    expect(s.idField).toBe("id");
    expect(s.fields).toHaveLength(10);
  });

  it("resolves the declared default columns", () => {
    const s = loadSchema(doc);
    expect(selectedFields(s, { select: [] }).map((f) => f.name)).toEqual([
      "job_name",
      "platform",
      "overall",
      "total_ms",
      "is_starred",
    ]);
  });

  it("projects sources: synthetic backend, derived, dotted path", () => {
    const s = loadSchema(doc);
    const by = (n: string) => s.fields.find((f) => f.name === n)!;
    expect(by("is_starred").source).toEqual({ kind: "backend", synthetic: true });
    expect(by("details").source).toEqual({ kind: "derived" });
    expect(by("enqueued_at").source).toEqual({ kind: "backend", path: "enqueued_at.Time" });
  });
});
