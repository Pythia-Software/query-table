// Exact design-prototype reductions. Production must negotiate method/precision.
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, lower = Math.floor(position), fraction = position - lower;
  const a = sorted[lower]!, b = sorted[Math.min(lower + 1, sorted.length - 1)]!;
  return (1 - fraction) * a + fraction * b;
}
export function boxSummary(values: number[], whiskers: 'minmax' | 'tukey' = 'minmax') {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  if (!n) return null;
  const min = sorted[0]!, max = sorted[n - 1]!, q1 = percentile(sorted, .25)!, median = percentile(sorted, .5)!, q3 = percentile(sorted, .75)!;
  const lowFence = q1 - 1.5 * (q3 - q1), highFence = q3 + 1.5 * (q3 - q1);
  const low = whiskers === 'tukey' ? sorted.find(v => v >= lowFence)! : min;
  const high = whiskers === 'tukey' ? [...sorted].reverse().find(v => v <= highFence)! : max;
  const outside = whiskers === 'tukey' ? sorted.filter(v => v < low || v > high) : [];
  // Bound the response while retaining both tails. Report the total separately.
  const outliers = outside.length <= 20 ? outside : [...outside.slice(0, 10), ...outside.slice(-10)];
  const mean = sorted.reduce((sum, value) => sum + value / n, 0);
  if (![min, q1, median, q3, max, mean, low, high].every(Number.isFinite)) throw Error('Distribution exceeds finite numeric precision.');
  return { n, min, q1, median, q3, max, mean, low, high, outliers, outlierCount: outside.length, whiskers, method: 'exact-linear' as const };
}
export function histogramEdges(values: number[], bins: number): number[] {
  if (!Number.isInteger(bins) || bins < 2 || bins > 30) throw Error('Choose 2–30 histogram bins.');
  if (!values.length) return [];
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  if (min === max) return [min, max]; // one point interval, not artificial spread
  if (!Number.isFinite(max - min)) throw Error('Histogram range exceeds finite numeric precision.');
  const edges = Array.from({ length: bins + 1 }, (_, i) => min + (max - min) * (i / bins));
  edges[0] = min; edges[bins] = max;
  if (edges.some((value, i) => i > 0 && value <= edges[i - 1]!)) throw Error('Histogram bins are finer than numeric precision. Reduce the bin count.');
  return edges;
}
export function histogramCounts(values: number[], edges: number[]): number[] {
  if (!edges.length) return [];
  const counts = Array<number>(edges.length - 1).fill(0);
  for (const value of values) {
    if (value < edges[0]! || value > edges[edges.length - 1]!) throw Error('Value falls outside shared histogram edges.');
    // Lower inclusive, upper exclusive; the last bin also includes the maximum.
    let bin = 0;
    while (bin < counts.length - 1 && value >= edges[bin + 1]!) bin++;
    counts[bin] = counts[bin]! + 1;
  }
  return counts;
}
