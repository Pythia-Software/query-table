// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  createPropertyView,
  memoryPropertyViewStorage,
  type FieldSchema,
  type PropertyViewState,
  type PropertyViewStorage,
} from "@pythia-software/query-table-core";
import { usePropertyView, type PropertyViewApi } from "../src/usePropertyView";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const schema: FieldSchema = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "name", label: "Name", type: "text", source: { kind: "backend" } },
    {
      name: "duration",
      label: "Duration",
      type: "number",
      source: { kind: "backend" },
    },
  ],
};
const alternate = createPropertyView(schema, ["duration"]);
async function mount(storage: PropertyViewStorage) {
  let api!: PropertyViewApi;
  const root = createRoot(document.createElement("div"));
  function Probe({ keyName }: { keyName: string }) {
    api = usePropertyView({ schema, key: keyName, storage });
    return null;
  }
  await act(async () =>
    root.render(createElement(Probe, { keyName: "calls" })),
  );
  return {
    api: () => api,
    switch: async (keyName: string) => {
      await act(async () => root.render(createElement(Probe, { keyName })));
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("usePropertyView", () => {
  it("can retry a failed last-view write by resetting the current view", async () => {
    const memory = memoryPropertyViewStorage();
    let fail = true;
    const probe = await mount({
      ...memory,
      async saveLast(key, view) {
        if (fail) throw Error("temporarily unavailable");
        await memory.saveLast(key, view);
      },
    });
    expect(probe.api().error?.message).toBe("temporarily unavailable");
    fail = false;
    await act(async () => probe.api().reset());
    expect(probe.api().error).toBeNull();
    expect(await memory.loadLast("calls")).toEqual(createPropertyView(schema));
    probe.unmount();
  });
  it("ignores late hydration from a previously selected object type", async () => {
    let finish!: (view: PropertyViewState) => void;
    const storage = {
      ...memoryPropertyViewStorage(),
      loadLast: (key: string) =>
        key === "calls"
          ? new Promise<PropertyViewState>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(null),
    };
    const probe = await mount(storage);
    await probe.switch("other");
    await act(async () => finish(alternate));
    expect(probe.api().view).toEqual(createPropertyView(schema));
    probe.unmount();
  });
  it("restores defaults, persists customization, saves multiple views and supports undo", async () => {
    const storage = memoryPropertyViewStorage();
    const saved = await storage.saveNamed("calls", "Duration", alternate, 1);
    await storage.setDefaultSaved("calls", saved.id);
    let probe = await mount(storage);
    expect(probe.api().view).toEqual(alternate);
    await act(async () => probe.api().setView(createPropertyView(schema)));
    expect(probe.api().canUndo).toBe(true);
    await act(async () => probe.api().undo());
    expect(probe.api().view).toEqual(alternate);
    await act(async () => probe.api().redo());
    await act(async () => {
      await probe.api().save("Full");
    });
    expect(probe.api().saved.map((v) => v.name)).toEqual(["Duration", "Full"]);
    probe.unmount();
    probe = await mount(storage);
    expect(probe.api().view.properties).toHaveLength(2);
    expect(probe.api().defaultId).toBe(saved.id);
    await probe.switch("other");
    expect(probe.api().saved).toEqual([]);
    expect(await storage.loadLast("calls")).toEqual(createPropertyView(schema));
    probe.unmount();
  });
  it("does not let a late restore overwrite a user's newer change", async () => {
    let restore!: (view: PropertyViewState) => void;
    const storage = {
      ...memoryPropertyViewStorage(),
      loadLast: () =>
        new Promise<PropertyViewState>((resolve) => {
          restore = resolve;
        }),
    };
    const probe = await mount(storage);
    expect(probe.api().loading).toBe(true);
    await act(async () => probe.api().setView(alternate));
    await act(async () => restore(createPropertyView(schema)));
    expect(probe.api().view).toEqual(alternate);
    probe.unmount();
  });
  it("surfaces restore and persistence failures without unhandled promises", async () => {
    const failed = await mount({
      ...memoryPropertyViewStorage(),
      loadLast: async () => {
        throw Error("storage unavailable");
      },
    });
    expect(failed.api().error?.message).toBe("storage unavailable");
    expect(failed.api().loading).toBe(false);
    failed.unmount();
    const probe = await mount({
      ...memoryPropertyViewStorage(),
      saveLast: async () => {
        throw Error("quota");
      },
    });
    expect(probe.api().error?.message).toBe("quota");
    probe.unmount();
  });
});
