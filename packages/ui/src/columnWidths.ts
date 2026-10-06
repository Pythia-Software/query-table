// columnWidths.ts — bulk column-width presets for the DataTable "widths" menu.
//
// Pure math only: DataTable measures content and the viewport, these helpers
// decide the pixel widths. Every result is integral and, when the columns can
// fit, sums to exactly the available width so no stray horizontal scrollbar
// appears.

export type ColumnWidthPreset = "content" | "screen" | "equal";

/** Narrowest column the screen/equal presets will produce. */
export const PRESET_MIN_WIDTH = 48;

/** Every column at its measured content width. */
export function fitContentWidths(content: number[], min = PRESET_MIN_WIDTH): number[] {
  return content.map((w) => Math.max(min, Math.ceil(w)));
}

/** The same width for every column, sharing the available width. */
export function equalWidths(count: number, available: number, min = PRESET_MIN_WIDTH): number[] {
  if (count <= 0) return [];
  if (available < count * min) return Array.from({ length: count }, () => min);
  return distributePixels(Array.from({ length: count }, () => available / count), available);
}

/**
 * Fill the available width exactly. When content fits, every column grows in
 * proportion to its content. When it does not, narrow columns keep their full
 * content width and only the widest columns are capped at a shared level
 * (water-filling), so truncation lands where there is the most text to lose.
 */
export function fitScreenWidths(content: number[], available: number, min = PRESET_MIN_WIDTH): number[] {
  const count = content.length;
  if (count === 0) return [];
  if (available < count * min) return content.map(() => min);
  const natural = content.map((w) => Math.max(min, w));
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= available) {
    return distributePixels(natural.map((w) => (w / total) * available), available);
  }
  const order = natural.map((w, i) => [w, i] as const).sort((a, b) => a[0] - b[0]);
  const widths = new Array<number>(count);
  let remaining = available;
  order.forEach(([w, i], rank) => {
    const share = remaining / (count - rank);
    const width = Math.min(w, share);
    widths[i] = width;
    remaining -= width;
  });
  return distributePixels(widths, available);
}

/** Round fractional widths down, then hand leftover pixels to the columns that
 *  lost the most to rounding, so the result sums to floor(total). */
function distributePixels(widths: number[], total: number): number[] {
  const floored = widths.map(Math.floor);
  let leftover = Math.floor(total) - floored.reduce((sum, w) => sum + w, 0);
  const byRemainder = widths
    .map((w, i) => [w - Math.floor(w), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (leftover <= 0) break;
    floored[i] = floored[i]! + 1;
    leftover -= 1;
  }
  return floored;
}
