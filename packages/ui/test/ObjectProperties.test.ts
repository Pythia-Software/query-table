// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  createPropertyView,
  memoryPropertyViewStorage,
  type FieldSchema,
  type RelationshipAdapter,
} from "@pythia-software/query-table-core";
import { ObjectProperties, formatPropertyValue } from "../src/ObjectProperties";
import { ObjectInspector } from "../src/ObjectInspector";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema = {
  name: "calls",
  idField: "id",
  fields: [
    {
      name: "command",
      label: "Command",
      type: "text",
      source: { kind: "backend" },
      render: "truncate",
    },
    {
      name: "duration",
      label: "Duration",
      type: "number",
      source: { kind: "backend" },
      property: { format: { kind: "duration", sourceUnit: "seconds" } },
    },
    {
      name: "owner",
      label: "Owner",
      type: "text",
      source: { kind: "backend" },
      relationship: { objectType: "person", key: { id: "owner" } },
    },
    {
      name: "enabled",
      label: "Enabled",
      type: "bool",
      source: { kind: "backend" },
    },
  ],
};
const row = {
  command: "echo hello\nsecond line",
  duration: 84,
  owner: "u1",
  enabled: false,
};
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text || button.getAttribute("aria-label") === text,
  )!;

describe("object properties", () => {
  it("ignores relationship responses for an object that is no longer displayed", async () => {
    const pending: Array<{ signal?: AbortSignal; finish: () => void }> = [];
    const relationships: RelationshipAdapter = {
      resolve(references, signal) {
        return new Promise((resolve) =>
          pending.push({
            ...(signal ? { signal } : {}),
            finish: () =>
              resolve(
                references.map((reference) => ({
                  reference,
                  label: reference.key.id === "u1" ? "Old owner" : "New owner",
                  href: `/users/${reference.key.id}`,
                })),
              ),
          }),
        );
      },
    };
    const container = document.createElement("div"),
      root = createRoot(container);
    const view = createPropertyView(schema, ["owner"]);
    await act(async () =>
      root.render(
        createElement(ObjectProperties, { schema, row, view, relationships }),
      ),
    );
    await act(async () =>
      root.render(
        createElement(ObjectProperties, {
          schema,
          row: { ...row, owner: "u2" },
          view,
          relationships,
        }),
      ),
    );
    expect(pending[0]?.signal?.aborted).toBe(true);
    await act(async () => pending[1]!.finish());
    await act(async () => pending[0]!.finish());
    expect(container.querySelector("a")?.textContent).toBe("New owner");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/users/u2",
    );
    act(() => root.unmount());
  });
  it("renders ordered fields, false and zero, wraps text, and preserves unavailable entries", async () => {
    const container = document.createElement("div"),
      root = createRoot(container);
    const view = createPropertyView(schema, [
      "duration",
      "enabled",
      "command",
      "missing",
    ]);
    await act(async () =>
      root.render(
        createElement(ObjectProperties, {
          schema,
          row: { ...row, duration: 0 },
          view,
        }),
      ),
    );
    expect(
      [...container.querySelectorAll("dt")].map((node) => node.textContent),
    ).toEqual(["Duration", "Enabled", "Command", "missing"]);
    expect(container.textContent).toContain("No");
    expect(container.textContent).toContain("0ms");
    expect(container.querySelector(".qt-truncate")).toBeNull();
    expect(container.textContent).toContain("Field unavailable");
    await act(async () =>
      root.render(
        createElement(ObjectProperties, {
          schema,
          row,
          view,
          loadedFields: ["command"],
        }),
      ),
    );
    expect(container.textContent).toContain("Not loaded");
    act(() => root.unmount());
  });
  it("resolves one batch, renders labels, and blocks unsafe links", async () => {
    const batches: unknown[] = [];
    const relationships: RelationshipAdapter = {
      async resolve(references) {
        batches.push(references);
        return references.map((reference) => ({
          reference,
          label: "Alex",
          href: "javascript:alert(1)",
        }));
      },
    };
    const container = document.createElement("div"),
      root = createRoot(container);
    const view = createPropertyView(schema, ["owner", "owner"]);
    await act(async () =>
      root.render(
        createElement(ObjectProperties, { schema, row, view, relationships }),
      ),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(container.textContent).toContain("Alex");
    expect(container.querySelector("a")).toBeNull();
    act(() => root.unmount());
  });
  it("applies edits transactionally and carries the saved view to another object", async () => {
    const storage = memoryPropertyViewStorage();
    const container = document.createElement("div"),
      root = createRoot(container);
    await act(async () =>
      root.render(createElement(ObjectInspector, { schema, row, storage })),
    );
    await act(async () => button(container, "Customize properties").click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove Command"]')!
        .click(),
    );
    expect(container.querySelector(".qt-object-inspector > .qt-object-properties dl")?.textContent).toContain("Command");
    await act(async () => button(container, "Cancel").click());
    expect(container.querySelector(".qt-object-inspector > .qt-object-properties dl")?.textContent).toContain("Command");
    await act(async () => button(container, "Customize properties").click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove Command"]')!
        .click(),
    );
    await act(async () => button(container, "Apply properties").click());
    expect(container.querySelector(".qt-object-inspector > .qt-object-properties dl")?.textContent).not.toContain("Command");
    await act(async () =>
      root.render(
        createElement(ObjectInspector, {
          schema,
          row: { ...row, owner: "u2" },
          storage,
        }),
      ),
    );
    expect(container.querySelector(".qt-object-inspector > .qt-object-properties dl")?.textContent).not.toContain("Command");
    act(() => root.unmount());
    const reopened = createRoot(container);
    await act(async () =>
      reopened.render(createElement(ObjectInspector, { schema, row, storage })),
    );
    expect(container.querySelector(".qt-object-inspector > .qt-object-properties dl")?.textContent).not.toContain("Command");
    act(() => reopened.unmount());
  });
  it("formats units, timestamps and currency without changing the raw values", () => {
    expect(
      formatPropertyValue(84, { kind: "duration", sourceUnit: "seconds" }).text,
    ).toBe("1m24s");
    expect(formatPropertyValue(2.75, { kind: "number" }).text).toBe("2.75");
    expect(
      formatPropertyValue(0, { kind: "currency", currency: "USD" }, "en-US")
        .text,
    ).toBe("$0.00");
    expect(
      formatPropertyValue(
        "2026-10-09T00:00:00Z",
        { kind: "relative" },
        "en-US",
        Date.parse("2026-10-12T00:00:00Z"),
      ).text,
    ).toBe("3 days ago");
    expect(
      formatPropertyValue("invalid", { kind: "datetime" }).error,
    ).toBeTruthy();
  });
});
