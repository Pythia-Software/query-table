// Machine-readable query errors. The codes are generated from
// schema/query-wire.schema.json (ErrorCode); docs/errors.md lists them.
import type { AggregationResultEntry } from "./encode";
import { ERROR_CODES, type ErrorCode, type QueryCapabilitiesV3, type QueryErrorBody, type QueryErrorDetail } from "./wire.generated";

export { ERROR_CODES };
export type { ErrorCode, QueryErrorBody, QueryErrorDetail };

const KNOWN = new Set<string>(ERROR_CODES);
/** Whether `value` is a code this build knows. Servers may send newer codes;
 * QueryError keeps them as strings. */
export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && KNOWN.has(value);

export interface QueryErrorOptions {
  field?: string;
  offset?: number;
  metricId?: string;
  /** The HTTP status, for errors read from a response. */
  status?: number;
  /** The capability flag a client-side refusal needs. */
  capability?: keyof QueryCapabilitiesV3;
  cause?: unknown;
}

/** An error with a stable code, from the server (QueryErrorBody) or from a
 * client-side refusal before any request is sent. Messages are for people;
 * match on `code`. */
export class QueryError extends Error {
  /** An ErrorCode, or a newer code this build does not know (narrow with
   * isErrorCode before an exhaustive switch). */
  readonly code: ErrorCode | (string & {});
  readonly field?: string;
  readonly offset?: number;
  readonly metricId?: string;
  readonly status?: number;
  readonly capability?: keyof QueryCapabilitiesV3;
  constructor(code: ErrorCode | (string & {}), message: string, options: QueryErrorOptions = {}) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    for (const key of ["field", "offset", "metricId", "status", "capability", "cause"] as const)
      if (options[key] !== undefined) (this as unknown as Record<string, unknown>)[key] = options[key];
  }
  /** The QueryErrorDetail wire shape of this error. */
  toJSON(): QueryErrorDetail {
    return { code: this.code, message: this.message, ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.offset !== undefined ? { offset: this.offset } : {}), ...(this.metricId !== undefined ? { metricId: this.metricId } : {}) };
  }
}

export const isQueryError = (error: unknown): error is QueryError => error instanceof QueryError;

/** The code a bare HTTP status implies, for bodies that are not a
 * QueryErrorBody (a proxy's error page, say). */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400: return "invalid_request";
    case 401: case 403: return "forbidden";
    case 404: return "not_found";
    case 405: return "method_not_allowed";
    case 408: return "cancelled";
    case 409: return "conflict";
    case 413: return "request_too_large";
    case 422: case 429: return "resource_limit";
    case 502: case 503: return "unavailable";
    case 504: return "timeout";
    case 507: return "quota_exceeded";
  }
  return "internal";
}

/** Reads a QueryErrorBody, or null when `body` is not one. */
export function parseQueryErrorBody(body: unknown): QueryErrorDetail | null {
  const error = (body as Partial<QueryErrorBody> | null)?.error;
  if (!error || typeof error !== "object" || typeof error.code !== "string" || !error.code || typeof error.message !== "string") return null;
  return { code: error.code, message: error.message,
    ...(typeof error.field === "string" ? { field: error.field } : {}),
    ...(Number.isSafeInteger(error.offset) ? { offset: error.offset } : {}),
    ...(typeof error.metricId === "string" ? { metricId: error.metricId } : {}) };
}

/** A QueryError from a QueryErrorBody (or a code and message). */
export function queryErrorFromBody(body: unknown, status?: number): QueryError | null {
  const detail = parseQueryErrorBody(body);
  if (!detail) return null;
  const { code, message, ...rest } = detail;
  return new QueryError(code, message, { ...rest, ...(status !== undefined ? { status } : {}) });
}

/** The QueryError of a failed fetch response: its QueryErrorBody when it has
 * one, otherwise a code from the status and a short message. Consumes the body. */
export async function queryErrorFromResponse(response: Response): Promise<QueryError> {
  let text = "";
  try { text = await response.text(); } catch { /* an unreadable body falls back to the status */ }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const parsed = queryErrorFromBody(body, response.status);
  if (parsed) return parsed;
  // Older servers wrote {"error": "message"} or plain text.
  const legacy = typeof (body as { error?: unknown } | undefined)?.error === "string" ? (body as { error: string }).error : text.trim();
  const message = legacy && legacy.length <= 500 && !/^\s*</.test(legacy) ? legacy : `Request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
  return new QueryError(errorCodeForStatus(response.status), message, { status: response.status });
}

/** A failed metric entry. A QueryError keeps its code; any other failure of
 * a local engine is `fallback`. */
export function failedMetric(id: string, error: unknown, fallback: ErrorCode): AggregationResultEntry {
  const code = error instanceof QueryError ? error.code : fallback;
  return { id, buckets: [], error: error instanceof Error ? error.message : String(error), errorCode: code };
}
