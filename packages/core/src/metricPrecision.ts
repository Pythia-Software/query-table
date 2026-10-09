import type { FormulaResult } from "./formula";

/** Display arithmetic uses doubles, but an integer outside the safe range is
 * never accepted as an exact metric sample or result. This is not decimal math. */
export function assertMetricNumber(value: number): void {
  if (
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    throw Error("Aggregate exceeds finite safe numeric precision.");
  }
}

export function checkedMetricResult(result: FormulaResult): FormulaResult {
  if (result.error || typeof result.value !== "number") return result;
  try {
    assertMetricNumber(result.value);
    return result;
  } catch (e) {
    return { value: null, error: (e as Error).message };
  }
}
