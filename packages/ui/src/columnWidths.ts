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
 *
 * `minimums` are per-column usable widths, such as the room a cell's buttons
 * or links need. No column is fitted below its minimum (or `min`); when the
 * minimums alone exceed the available width, every column takes its minimum
 * and the table scrolls rather than clip a control.
 */
export function fitScreenWidths(content: number[], available: number, min = PRESET_MIN_WIDTH, minimums: readonly number[] = []): number[] {
  const count = content.length;
  if (count === 0) return [];
  const floors = content.map((_, i) => Math.max(min, Math.ceil(minimums[i] ?? 0)));
  const floorTotal = floors.reduce((sum, w) => sum + w, 0);
  if (available <= floorTotal) return floors;
  const natural = content.map((w, i) => Math.max(floors[i]!, w));
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= available) {
    return distributePixels(natural.map((w) => (w / total) * available), available);
  }
  // The shared cap: columns wider than it are cut to it, never below their floor.
  const fill = (level: number) => natural.map((w, i) => Math.min(w, Math.max(floors[i]!, level)));
  let low = 0, high = Math.max(...natural);
  for (let i = 0; i < 64; i++) {
    const level = (low + high) / 2;
    if (fill(level).reduce((sum, w) => sum + w, 0) > available) high = level;
    else low = level;
  }
  return distributePixels(fill(low), available, floors);
}

/** Round fractional widths down, then hand leftover pixels to the columns that
 *  lost the most to rounding, so the result sums to floor(total). */
function distributePixels(widths: number[], total: number, floors: readonly number[] = []): number[] {
  const floored = widths.map((w, i) => Math.max(floors[i] ?? 0, Math.floor(w)));
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
