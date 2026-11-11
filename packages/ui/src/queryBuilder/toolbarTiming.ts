// Toolbar timing: auto-refresh frequency/turn-off options, share-feedback delay,
// and duration / status-time formatting.

export const MAX_AUTO_REFRESH_POLLS = 1000;
export const DEFAULT_AUTO_REFRESH_FREQUENCY_MS = 20_000;
export const DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS = 5 * 60_000;
export const SHARE_FEEDBACK_MS = 2_000;

export const AUTO_REFRESH_FREQUENCIES = [
  { label: "Every 5s", value: 5_000 },
  { label: "Every 10s", value: 10_000 },
  { label: "Every 20s", value: DEFAULT_AUTO_REFRESH_FREQUENCY_MS },
  { label: "Every 30s", value: 30_000 },
  { label: "Every 1m", value: 60_000 },
  { label: "Every 2m", value: 2 * 60_000 },
  { label: "Every 5m", value: 5 * 60_000 },
  { label: "Every 10m", value: 10 * 60_000 },
] as const;

export const AUTO_REFRESH_TURN_OFF_AFTER = [
  { label: "After 5m", value: DEFAULT_AUTO_REFRESH_TURN_OFF_AFTER_MS },
  { label: "After 15m", value: 15 * 60_000 },
  { label: "After 30m", value: 30 * 60_000 },
  { label: "After 1h", value: 60 * 60_000 },
  { label: "After 2h", value: 2 * 60 * 60_000 },
  { label: "After 4h", value: 4 * 60 * 60_000 },
  { label: "After 8h", value: 8 * 60 * 60_000 },
  { label: "After 12h", value: 12 * 60 * 60_000 },
  { label: "After 24h", value: 24 * 60 * 60_000 },
] as const;

export function autoRefreshPolls(frequencyMs: number, turnOffAfterMs: number): number {
  if (frequencyMs <= 0 || turnOffAfterMs <= 0) return Infinity;
  return Math.floor(turnOffAfterMs / frequencyMs);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${minutes}m`;
}

export function formatStatusTime(ms: number | null): string {
  if (ms == null) return "never";
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
