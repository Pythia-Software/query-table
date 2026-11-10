import { useState } from "react";
import { boxSummary, type AggregationBucket as MetricBucket, type AggregationClause as RenderingClause, type FieldDef } from "@pythia-software/query-table-core";
import { MetricCard } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import "./demo.css";

const fields: FieldDef<unknown>[] = [
  { name: "cost", label: "Cost", type: "number", source: { kind: "backend" } },
  { name: "calls", label: "Calls", type: "number", source: { kind: "backend" } },
  { name: "repository", label: "Repository", type: "text", source: { kind: "backend" } },
  { name: "provider", label: "Provider", type: "text", source: { kind: "backend" } },
  { name: "model_family", label: "Model family", type: "text", source: { kind: "backend" } },
  { name: "day", label: "Day", type: "datetime", source: { kind: "backend" } },
  { name: "tool", label: "Tool", type: "text", source: { kind: "backend" } },
  // A measure's declared numeric display is its metrics' default format:
  // values, axes, tooltips and totals.
  { name: "spend", label: "Spend", type: "number", source: { kind: "backend" }, display: { kind: "currency", currency: "USD" } },
  { name: "tokens", label: "Tokens", type: "number", source: { kind: "backend" }, display: { kind: "number", notation: "compact" } },
];
// Thirty-character labels, as repository and provider/model names often are.
const repositories = ["pythia-software/query-table-go", "pythia-software/pharos-archive", "claude / claude-opus-4-20250514", "short"];
const distribution = (i: number): MetricBucket => ({
  keys: [repositories[i]!], value: 10 + i, count: 20,
  distribution: { kind: "box", summary: boxSummary(Array.from({ length: 20 }, (_, j) => (j * (i + 2)) % 17 + i))! },
});
const box: RenderingClause = { id: "box", op: "sum", field: "cost", groupBy: ["repository"], label: "Cost by repository", distribution: { kind: "box", input: "cost" }, display: { kind: "box" } };
const bars: RenderingClause = { id: "bars", op: "sum", field: "cost", groupBy: ["repository"], label: "Cost by repository", display: { kind: "bar-horizontal" } };
const columns: RenderingClause = { ...bars, id: "columns", display: { kind: "bar-vertical" } };
const pairs: MetricBucket[] = [
  { keys: ["claude", "opus"], value: 5, count: 5 },
  { keys: ["claude", "sonnet"], value: 3, count: 3 },
  { keys: ["codex", "gpt-5"], value: 2, count: 2 },
];
const pie: RenderingClause = { id: "pie", op: "count", groupBy: ["provider", "model_family"], label: "Conversations by provider and model", display: { kind: "pie" } };
const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
// One series stays near zero; the other peaks once and is padded with zeros.
const series: MetricBucket[] = [
  ...days.map((day, i) => ({ keys: [day, "Read"], value: [3, 4, 3][i]!, count: 1 })),
  ...days.map((day, i) => ({ keys: [day, "Bash"], value: [0, 120, 0][i]!, count: 1 })),
];
const spend: RenderingClause = { id: "spend", op: "sum", field: "spend", groupBy: ["provider"], label: "Spend by provider", display: { kind: "bar-horizontal" } };
const spendBuckets: MetricBucket[] = [
  { keys: ["anthropic"], value: 1834.5, count: 9 },
  { keys: ["openai"], value: 912.25, count: 7 },
  { keys: ["google"], value: 87.1, count: 3 },
];
const total: RenderingClause = { id: "total", op: "sum", field: "spend", groupBy: [], label: "Spend (compact currency)", display: { kind: "value", format: { kind: "currency", currency: "USD", notation: "compact" } } };
const tokens: RenderingClause = { id: "tokens", op: "sum", field: "tokens", groupBy: ["provider"], label: "Tokens by provider", display: { kind: "bar-vertical" } };
const tokenBuckets: MetricBucket[] = [
  { keys: ["anthropic"], value: 3_412_000, count: 9 },
  { keys: ["openai"], value: 1_250_000, count: 7 },
  { keys: ["google"], value: 84_300, count: 3 },
];
const line: RenderingClause = { id: "line", op: "sum", field: "calls", groupBy: ["day", "tool"], label: "Calls by day and tool", display: { kind: "line" } };
// Wilson intervals around a share of turns, as the local engine returns them.
// The widest upper bound sets the axis; "short" has no bounds.
const percent = { kind: "percent" as const, decimals: 1 };
const shares: RenderingClause = {
  id: "interval-bars", op: "count", expression: "SUM([calls])/NULLIF(COUNT(),0)", groupBy: ["repository"],
  label: "Share with an interval", interval: { kind: "proportion" }, display: { kind: "bar-vertical", format: percent },
};
const shareBuckets: MetricBucket[] = [
  { keys: [repositories[0]!], value: 0.047, count: 128, lower: 0.022, upper: 0.098 },
  { keys: [repositories[1]!], value: 0.154, count: 52, lower: 0.08, upper: 0.275 },
  { keys: [repositories[2]!], value: 0.4, count: 15, lower: 0.198, upper: 0.643 },
  { keys: [repositories[3]!], value: 0.2, count: 3 },
];
const intervalLine: RenderingClause = { ...shares, id: "interval-line", groupBy: ["day", "tool"], label: "Daily share with an interval", display: { kind: "line", format: percent } };
const intervalSeries: MetricBucket[] = [
  ...days.map((day, i) => ({ keys: [day, "Read"], value: [0.1, 0.2, 0.15][i]!, count: 40, lower: [0.04, 0.1, 0.07][i]!, upper: [0.22, 0.34, 0.28][i]! })),
  ...days.map((day, i) => ({ keys: [day, "Bash"], value: [0.5, 0.6, 0.55][i]!, count: 12, lower: [0.25, 0.36, 0.3][i]!, upper: [0.75, 0.8, 0.78][i]! })),
];

/** Synthetic chart layouts for the browser checks in demo/chart-layout-test.mjs. */
export function ChartLayoutDemo() {
  const [inspected, setInspected] = useState("Nothing inspected");
  const inspect = (bucket: MetricBucket) => setInspected(`Inspected ${bucket.keys.join(" / ")}`);
  const card = (clause: RenderingClause, buckets: MetricBucket[], compact = false) => (
    <div className="qt-demo-chart-card" data-chart={`${clause.id}${compact ? "-compact" : ""}`}>
      <MetricCard clause={clause} buckets={buckets} fields={fields} compact={compact} locale="en-US" onInspect={inspect} />
    </div>
  );
  const labelled = repositories.map((_, i) => distribution(i));
  return (
    <main className="qt-demo qt-demo-charts">
      <h1>Chart layout</h1>
      <p role="status" data-inspected>{inspected}</p>
      <div className="qt-demo-chart-grid">
        {card(box, labelled)}
        {card(box, labelled, true)}
        {card(bars, labelled)}
        {card(bars, labelled, true)}
        {card(columns, labelled)}
        {card(pie, pairs)}
        {card(line, series)}
        {card(spend, spendBuckets)}
        {card(total, [{ keys: [], value: 2_833_850, count: 19 }])}
        {card(tokens, tokenBuckets)}
        {card(tokens, tokenBuckets, true)}
        {card(shares, shareBuckets)}
        {card({ ...shares, display: { ...shares.display!, kind: "bar-horizontal" } }, shareBuckets, true)}
        {card(intervalLine, intervalSeries)}
      </div>
    </main>
  );
}
