import { expect, it } from "vitest";
import {
  observeTransport,
  type RequestActivityEntry,
} from "../src/useRequestActivity";

it("observes transport calls with their receiver and records cancellation once", async () => {
  const events: RequestActivityEntry[] = [];
  let id = 0,
    resolve!: (value: { rows: never[]; total: number }) => void;
  const source = {
    total: 3,
    async fetchRows() {
      expect(this).toBe(source);
      return new Promise<{ rows: never[]; total: number }>((r) => {
        resolve = r;
      });
    },
  };
  const transport = observeTransport(
    Object.freeze(source),
    (e) => events.push(e),
    () => ++id,
  );
  const ac = new AbortController();
  const result = transport.fetchRows(
    { select: [], where: [], orderBy: [], limit: 1, offset: 0 },
    ac.signal,
  );
  expect(events[0]?.status).toBe("pending");
  ac.abort();
  expect(events[1]?.status).toBe("aborted");
  resolve({ rows: [], total: 3 });
  expect((await result).total).toBe(3);
  expect(events).toHaveLength(2);
  expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
});
it("preserves original errors and optional capabilities", async () => {
  const failure = Error("Offline"),
    events: RequestActivityEntry[] = [];
  const transport = observeTransport(
    {
      async fetchRows() {
        throw failure;
      },
    },
    (e) => events.push(e),
    () => 1,
  );
  expect(transport.fetchMetrics).toBeUndefined();
  await expect(
    transport.fetchRows({
      select: [],
      where: [],
      orderBy: [],
      limit: 1,
      offset: 0,
    }),
  ).rejects.toBe(failure);
  expect(events.map((e) => e.status)).toEqual(["pending", "error"]);
  expect(events[1]?.error).toBe("Offline");
});
