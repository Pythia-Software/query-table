const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
/** Portable datetime/offset bound in milliseconds (also below MAX_SAFE_INTEGER). */
export const MAX_RELATIVE_TIME_MS = 8_640_000_000_000_000;

/** A signed elapsed offset, e.g. -1h or +8d2h10m. The sign applies to the
 * complete sum. Returns null for absolute values or invalid duration syntax.
 * Units are lowercase; amounts are whole integers. No whitespace, calendar
 * arithmetic, locale, or Date.parse heuristics are used. */
export function parseRelativeDuration(value: string): number | null {
  const valid = /^[+-](?:[0-9]+(?:ms|s|m|h|d|w))+$/.exec(value);
  if (!valid || valid[0] !== value) return null;
  const body = value.slice(1);
  const components = /([0-9]+)(ms|s|m|h|d|w)/g;
  let total = 0;
  for (const match of body.matchAll(components)) {
    const amount = Number(match[1]);
    const unit = UNIT_MS[match[2]!]!;
    if (!Number.isSafeInteger(amount) || amount > Math.floor((MAX_RELATIVE_TIME_MS - total) / unit)) return null;
    total += amount * unit;
  }
  return value[0] === "-" && total !== 0 ? -total : total;
}

/** Local execution only. The server independently owns its execution clock. */
export interface QueryEvaluationOptions { now?: number }

export function evaluationTime(options: QueryEvaluationOptions): number {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || Math.abs(now) > MAX_RELATIVE_TIME_MS) throw new Error("Invalid query evaluation time");
  return now;
}

export function relativeTimestamp(now: number, offsetMs: number): number {
  const result = now + offsetMs;
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_RELATIVE_TIME_MS) throw new Error("Relative time exceeds datetime limits");
  return result;
}
