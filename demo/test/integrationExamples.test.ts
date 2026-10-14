import { describe, expect, it } from "vitest";
import { createQueryLinkService, encodeQuery, memoryQuerySnapshotCache } from "@pythia-software/query-table-core";
import { createIntegrationHost, EXAMPLE_SCHEMA, EXAMPLE_VIEWS } from "../src/showcase/integrationExamples";

describe("integration guide host example", () => {
  it("resolves a short link through a fresh client without a shared cache", async () => {
    const host = createIntegrationHost();
    const sender = createQueryLinkService(EXAMPLE_SCHEMA.name, host.snapshots, { cache: host.cache });
    const query = EXAMPLE_VIEWS[1]!.query;
    const link = await sender.durable(query, "https://your-app.example/orders");
    expect(link.kind).toBe("durable");
    expect(host.publishedCount).toBe(1);
    const receiver = createQueryLinkService(EXAMPLE_SCHEMA.name, host.snapshots, { cache: memoryQuerySnapshotCache() });
    expect(encodeQuery((await receiver.resolve(link.url))!)).toBe(encodeQuery(query));
    expect(host.reads).toBe(1);
    expect(await sender.durable(query, "https://your-app.example/orders")).toEqual(link);
    expect(host.publishedCount).toBe(1);
  });

  it("retains immutable snapshots independently of named saves and dataset scope", async () => {
    const host = createIntegrationHost();
    const snapshot = { version: 1 as const, code: "a".repeat(22), token: encodeQuery(EXAMPLE_VIEWS[1]!.query), createdAt: 10 };
    await host.snapshots.save("orders", snapshot);
    expect(await host.snapshots.save("orders", { ...snapshot, createdAt: 20 })).toEqual(snapshot);
    await expect(host.snapshots.save("orders", { ...snapshot, token: encodeQuery(EXAMPLE_VIEWS[2]!.query) })).rejects.toThrow("immutable");
    const saved = await host.storage.saveNamed("orders", "Focused view", EXAMPLE_VIEWS[1]!.query, 100, snapshot.code);
    await host.storage.deleteSaved("orders", saved.id);
    expect(await host.snapshots.resolve("orders", snapshot.code)).toEqual(snapshot);
    expect(await host.snapshots.resolve("other-dataset", snapshot.code)).toBeNull();
    expect(createIntegrationHost().publishedCount).toBe(0);
  });
});
