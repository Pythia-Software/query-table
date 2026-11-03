import { expect, it } from "vitest";
import { EMPTY_QUERY, toDistinctRequestV3, toQueryRequestV3, type FieldSchema, type QueryResultV3, type Transport } from "@pythia-software/query-table-core";
import {
  observeTransport,
  type RequestActivityEntry,
} from "../src/useRequestActivity";
import { MEMORY_V3_CAPABILITIES, v3Response } from "./v3Transport";

const schema: FieldSchema = { name: "runs", idField: "id", fields: [{ name: "id", label: "ID", type: "number", source: { kind: "backend" } }] };
const rowsRequest = toQueryRequestV3(EMPTY_QUERY, schema, MEMORY_V3_CAPABILITIES, undefined, { now: 1 });

it("observes transport calls with their receiver and records cancellation once", async () => {
  const events: RequestActivityEntry[] = [];
  let id = 0,
    resolve!: (value: QueryResultV3) => void;
  const source: Transport & { total: number } = {
    total: 3,
    queryCapabilities: MEMORY_V3_CAPABILITIES,
    async fetchQueryV3() {
      expect(this).toBe(source);
      return new Promise<QueryResultV3>((r) => {
        resolve = r;
      });
    },
  };
  const transport = observeTransport(
    Object.freeze(source),
    (e) => events.push(e),
    () => ++id,
  );
  expect(transport.queryCapabilities).toBe(MEMORY_V3_CAPABILITIES);
  const ac = new AbortController();
  const result = transport.fetchQueryV3(rowsRequest, ac.signal);
  expect(events[0]?.status).toBe("pending");
  expect(events[0]?.kind).toBe("Rows");
  ac.abort();
  expect(events[1]?.status).toBe("aborted");
  resolve(v3Response(rowsRequest, { total: 3 }));
  expect((await result).total).toBe(3);
  expect(events).toHaveLength(2);
  expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
});
it("preserves original errors and names each request by what it asks for", async () => {
  const failure = Error("Offline"),
    events: RequestActivityEntry[] = [];
  const transport = observeTransport(
    {
      queryCapabilities: MEMORY_V3_CAPABILITIES,
      async fetchQueryV3(request) {
        if (request.rows) throw failure;
        return v3Response(request);
      },
    },
    (e) => events.push(e),
    () => events.length,
  );
  await expect(transport.fetchQueryV3(rowsRequest)).rejects.toBe(failure);
  expect(events.map((e) => e.status)).toEqual(["pending", "error"]);
  expect(events[1]?.error).toBe("Offline");
  await transport.fetchQueryV3({ ...rowsRequest, rows: false });
  await transport.fetchQueryV3(toDistinctRequestV3("id", "", MEMORY_V3_CAPABILITIES, { now: 1 }));
  expect(events.filter((e) => e.status === "success").map((e) => e.kind)).toEqual(["Metrics", "DistinctValues"]);
});
