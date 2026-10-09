import type {
  AggregationResult,
  ComputedColumn,
  ComputedExecution,
  FetchRowsResultV2,
  ServerQuery,
  ServerQueryV2,
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
  maxRows: number;
  maxGroups: number;
  profile: string;
}
export interface DemoLatency {
  db: number;
  response: number;
}
export interface DemoMetricTiming {
  id: string;
  sqlMs: number;
  planMs: number;
  stages: number;
  sqlBytes: number;
}
export interface DemoRequest {
  metrics?: DemoMetricTiming[];
  id: number;
  kind: string;
  started: number;
  duration?: number;
  status: "pending" | "complete" | "aborted" | "error";
  sqlMs?: number;
  dbDelayMs?: number;
  responseDelayMs?: number;
  statements?: number;
  error?: string;
}

export function createPostgresTransport(
  getExecution: () => ComputedExecution,
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
      const result = (await response.json()) as Result & {
        error?: string;
        debug?: { metrics?: DemoMetricTiming[] };
      };
      if (!response.ok)
        throw new Error(result.error ?? `HTTP ${response.status}`);
      if (signal?.aborted)
        throw new DOMException("Request aborted", "AbortError");
      const header = (name: string) => Number(response.headers.get(name) ?? 0);
      onRequest({
        ...request,
        status: "complete",
        ...(result.debug?.metrics ? { metrics: result.debug.metrics } : {}),
        duration: performance.now() - request.started,
        sqlMs: header("X-Demo-SQL-Ms"),
        dbDelayMs: header("X-Demo-DB-Delay-Ms"),
        responseDelayMs: header("X-Demo-Response-Delay-Ms"),
        statements: header("X-Demo-Statements"),
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
  const fetchRowsV2 = (query: ServerQueryV2, signal?: AbortSignal) =>
    post<FetchRowsResultV2<PostgresRun>>("Rows", "rows", query, signal);
  return {
    metricCapabilities: {
      version: 2,
      expressions: true,
      distributions: true,
      shownRows: true,
      computedFields: true,
      profile: "qt-postgres-v1",
      maxGroups: 10000,
    },
    fetchRowsV2,
    // Computed previews use the legacy transport seam but still execute Go's v2 planner.
    fetchRows(query: ServerQuery, signal?: AbortSignal) {
      const execution = getExecution();
      return fetchRowsV2(
        {
          ...query,
          version: 2,
          profile: execution.profile,
          expectedRevisions: execution.resolvedRevisions,
          planToken: execution.planToken,
          ...(execution.snapshot ? { snapshot: execution.snapshot } : {}),
          diagnostics: [],
        },
        signal,
      );
    },
    async fetchMetrics(query, signal) {
      // Each shard imports the same exported MVCC snapshot and canonical
      // revision set. Bound fan-out to the host's four execution slots.
      const count = Math.min(
        4,
        Math.max(1, Math.ceil(query.metrics.length / 5)),
      );
      const shards = Array.from(
        { length: count },
        () => [] as typeof query.metrics,
      );
      query.metrics.forEach((metric, index) =>
        shards[index % count]!.push(metric),
      );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      try {
        const results = await Promise.all(
          shards.map((metrics) =>
            post<AggregationResult>(
              `Metrics · ${metrics.length}`,
              "metrics",
              { ...query, metrics },
              controller.signal,
            ),
          ),
        );
        return { metrics: results.flatMap((result) => result.metrics) };
      } catch (error) {
        controller.abort(); // A failed shard must not leave sibling SQL running.
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    fetchDistinctValues(query, signal) {
      return post("Field values", "distinct", query, signal);
    },
  };
}
