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
const line: RenderingClause = { id: "line", op: "sum", field: "calls", groupBy: ["day", "tool"], label: "Calls by day and tool", display: { kind: "line" } };

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
      </div>
    </main>
  );
}
