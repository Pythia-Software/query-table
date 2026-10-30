import { expect, it, vi } from "vitest";
import { createAttentionRegistry } from "../src/attention";

it("waits for readiness and materialization before revealing exact semantic identities", async () => {
  const registry = createAttentionRegistry();
  const target = { dataset: "items", rowId: 0, field: "payload", path: '$["a.b"][20]' };
  const reveal = vi.fn((_target: unknown, _signal: AbortSignal) => true);
  registry.register({ dataset: "items" }, { ready: async () => {}, materialize: async (_, signal) => {
    const mounted = registry.whenRegistered(target, signal);
    queueMicrotask(() => registry.register(target, { reveal }));
    await mounted; return true;
  }, reveal: (next, signal) => registry.whenRegistered(target, signal).then(provider => provider.reveal(next, signal)) });
  expect(await registry.resolve(target)).toEqual({ status: "revealed", target });
  expect(reveal).toHaveBeenCalledOnce();
  expect(reveal.mock.calls[0]![0]).toEqual(target);
  registry.register(target, { reveal: () => false });
  expect(await registry.resolve(target)).toEqual({ status: "unavailable", target });
});
it("cancels superseded and externally aborted navigation while waiting for rendering", async () => {
  const registry = createAttentionRegistry();
  registry.register({ dataset: "items" }, { reveal: async (target, signal) => {
    await registry.whenRegistered(target, signal); return !signal.aborted;
  } });
  const first = registry.resolve({ dataset: "items", rowId: "old" });
  const controller = new AbortController();
  const second = registry.resolve({ dataset: "items", rowId: "new" }, { signal: controller.signal });
  controller.abort();
  expect((await first).status).toBe("cancelled");
  expect((await second).status).toBe("cancelled");
  expect((await registry.resolve({ dataset: "missing", rowId: 0 })).status).toBe("unavailable");
});
