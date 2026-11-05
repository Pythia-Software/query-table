import type {
  ComputedColumn,
  ComputedExecution,
  QueryCapabilitiesV3,
  QueryRequestV3,
  QueryResultV3,
  Transport,
} from "@pythia-software/query-table-core";

export type PostgresRun = Record<string, unknown> & { id: number };
export interface DemoBootstrap {
  dataset: string;
  rows: number;
  bytes: number;
  postgresVersion: string;
  execution: ComputedExecution;
  columns: ComputedColumn[];
  completed: number;
  canceled: number;
  capabilities: QueryCapabilitiesV3;
}
export interface DemoLatency {
  db: number;
  response: number;
}
export interface DemoRequest {
  id: number;
  kind: string;
  started: number;
  duration?: number;
  status: "pending" | "complete" | "aborted" | "error";
  sqlMs?: number;
  dbDelayMs?: number;
  responseDelayMs?: number;
  error?: string;
}

export function createPostgresTransport(
  capabilities: QueryCapabilitiesV3,
  getLatency: () => DemoLatency,
  onRequest: (request: DemoRequest) => void,
): Transport<PostgresRun> {
  let sequence = 0;
  async function post<Result>(
    kind: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    const request: DemoRequest = {
      id: ++sequence,
      kind,
      started: performance.now(),
      status: "pending",
    };
    onRequest(request);
    try {
      const latency = getLatency();
      const response = await fetch(`/api/postgres/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Demo-DB-Delay": String(latency.db),
          "X-Demo-Response-Delay": String(latency.response),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      const result = (await response.json()) as Result & { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? `HTTP ${response.status}`);
      if (signal?.aborted)
        throw new DOMException("Request aborted", "AbortError");
      const header = (name: string) => Number(response.headers.get(name) ?? 0);
      onRequest({
        ...request,
        status: "complete",
        duration: performance.now() - request.started,
        sqlMs: header("X-Demo-SQL-Ms"),
        dbDelayMs: header("X-Demo-DB-Delay-Ms"),
        responseDelayMs: header("X-Demo-Response-Delay-Ms"),
      });
      return result;
    } catch (error) {
      const aborted =
        signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      onRequest({
        ...request,
        status: aborted ? "aborted" : "error",
        duration: performance.now() - request.started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  const kind = (request: QueryRequestV3) =>
    request.distinct ? "Field values" : request.rows ? "Rows" : `Metrics · ${request.metrics.length}`;
  return {
    queryCapabilities: capabilities,
    async fetchQueryV3(request, signal) {
      if (request.rows || request.distinct || request.metrics.length <= 5)
        return post<QueryResultV3>(kind(request), "query", request, signal);
      // Metric batches shard across the host's four execution slots. Each shard
      // imports the same exported MVCC snapshot and canonical revision set.
      const count = Math.min(4, Math.ceil(request.metrics.length / 5));
      const shards = Array.from({ length: count }, () => [] as QueryRequestV3["metrics"]);
      request.metrics.forEach((metric, index) => shards[index % count]!.push(metric));
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      try {
        const results = await Promise.all(shards.map((metrics) => {
          const shard = { ...request, metrics };
          return post<QueryResultV3>(kind(shard), "query", shard, controller.signal);
        }));
        const byId = new Map(results.flatMap((result) => result.metrics).map((entry) => [entry.id, entry]));
        return { ...results[0]!, metrics: request.metrics.map((metric) => byId.get(metric.id)!) };
      } catch (error) {
        controller.abort(); // A failed shard must not leave sibling SQL running.
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
