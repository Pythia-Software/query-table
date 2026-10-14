// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATASETS } from "../src/showcase/data";
import { exampleQueryId, showcaseQueryStorage } from "../src/showcase/storage";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("showcase saved-query catalogue", () => {
  it("preserves a personal saved view, its identity, and its default across adapters", async () => {
    const dataset = DATASETS[0]!;
    const first = showcaseQueryStorage(dataset);
    const key = dataset.schema.name;
    const query = { ...dataset.defaults, limit: 7 };
    const saved = await first.saveNamed(key, "My view", query, 1234);
    await first.setDefaultSaved!(key, saved.id);
    const updated = await first.updateNamed!(
      key,
      saved.id,
      { ...query, limit: 11 },
      5678,
    );
    const second = showcaseQueryStorage(dataset);
    expect(
      (await second.listSaved(key)).find((item) => item.id === saved.id),
    ).toEqual(updated);
    expect((await second.loadDefaultSaved!(key))?.query.limit).toBe(11);
    await second.deleteSaved(key, saved.id);
    expect(await second.loadDefaultSaved!(key)).toBeNull();
    expect(await second.listSaved(key)).toHaveLength(dataset.recipes.length);
  });
  it("protects example views from edits, deletion, and mutable catalogue consumers", async () => {
    const dataset = DATASETS[0]!;
    const storage = showcaseQueryStorage(dataset);
    const key = dataset.schema.name,
      id = exampleQueryId(dataset.id, 0);
    const original = (await storage.listSaved(key)).find(
      (item) => item.id === id,
    )!;
    original.query.limit = 1;
    expect(
      (await storage.listSaved(key)).find((item) => item.id === id)?.query
        .limit,
    ).toBe(dataset.defaults.limit);
    await expect(
      storage.updateNamed!(key, id, { ...dataset.defaults, limit: 1 }, 1234),
    ).rejects.toThrow("Save a copy");
    await expect(storage.deleteSaved(key, id)).rejects.toThrow(
      "Example queries",
    );
    await expect(
      storage.saveNamed(key, dataset.recipes[0]!.name, dataset.defaults, 1234),
    ).rejects.toThrow("different name");
    expect(
      (await storage.listSaved(key)).find((item) => item.id === id)?.query
        .limit,
    ).toBe(dataset.defaults.limit);
  });
  it("keeps the same personal query name isolated by dataset", async () => {
    for (const [index, dataset] of DATASETS.entries()) {
      await showcaseQueryStorage(dataset).saveNamed(
        dataset.schema.name,
        "My view",
        { ...dataset.defaults, limit: index + 1 },
        100 + index,
      );
    }
    for (const [index, dataset] of DATASETS.entries()) {
      const saved = (
        await showcaseQueryStorage(dataset).listSaved(dataset.schema.name)
      ).filter((item) => item.name === "My view");
      expect(saved).toHaveLength(1);
      expect(saved[0]?.query.limit).toBe(index + 1);
    }
  });
  it("retains session saves when browser storage is unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    const dataset = DATASETS[0]!,
      key = "showcase-session-test";
    const first = showcaseQueryStorage(dataset);
    const saved = await first.saveNamed(
      key,
      "Session view",
      dataset.defaults,
      1,
    );
    expect(
      (await showcaseQueryStorage(dataset).listSaved(key)).some(
        (item) => item.id === saved.id,
      ),
    ).toBe(true);
  });
});
