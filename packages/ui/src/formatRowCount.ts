const exactRowCountFormatter = new Intl.NumberFormat();

/** Format a row count compactly once grouping separators become hard to scan. */
export function formatRowCount(count: number, maximumSignificantDigits = 3): string {
  if (!Number.isFinite(count)) return String(count);
  if (Math.abs(count) < 10_000) return exactRowCountFormatter.format(count);

  const precision = Math.min(4, Math.max(1, Math.trunc(maximumSignificantDigits)));
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumSignificantDigits: precision,
  }).format(count);
}

/** Return the full grouped count when the visible form is abbreviated. */
export function rowCountTitle(count: number, formatted = formatRowCount(count)): string | undefined {
  const exact = exactRowCountFormatter.format(count);
  return formatted === exact ? undefined : exact;
}
