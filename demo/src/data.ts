// Mock dataset for the client-side demo. Shapes match the `runs` schema
// (schema/examples/runs.schema.json) so the table renders with no backend.

export interface Run {
  id: number;
  job_name: string | null;
  platform: "windows" | "macos" | "linux";
  overall: "PASS" | "FAIL" | "DIFFERENCES" | null;
  total_ms: number | null;
  worker: string;
  enqueued_at: string | null;
  is_starred: boolean;
  error_codes: string[] | null;
}

const PLATFORMS = ["windows", "macos", "linux"] as const;
const OVERALLS = ["PASS", "FAIL", "DIFFERENCES", null] as const;
const JOBS = [
  "checkout-flow",
  "login-oauth",
  "invoice-export",
  "report-builder",
  "pivot-refresh",
  "merge-conflict",
  "bulk-upload",
  "search-index",
  null,
];

// Deterministic pseudo-random so the dataset is stable across reloads.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export const RUNS: Run[] = Array.from({ length: 40 }, (_, i) => {
  const r = rng(i + 1);
  const overall = OVERALLS[Math.floor(r() * OVERALLS.length)]!;
  const day = String((i % 27) + 1).padStart(2, "0");
  const hr = String(Math.floor(r() * 24)).padStart(2, "0");
  return {
    id: 1000 + i,
    job_name: JOBS[Math.floor(r() * JOBS.length)]!,
    platform: PLATFORMS[Math.floor(r() * PLATFORMS.length)]!,
    overall,
    total_ms: r() < 0.1 ? null : Math.floor(r() * 120000),
    worker: `worker-${1 + Math.floor(r() * 4)}`,
    enqueued_at: `2026-05-${day}T${hr}:00:00Z`,
    is_starred: r() < 0.25,
    error_codes: overall === "FAIL" ? ["timeout", "validation"].slice(0, 1 + Math.floor(r() * 2)) : null,
  };
});
