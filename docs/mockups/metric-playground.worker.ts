// Design-only aggregate scaffold. Production needs aggregate-aware parsing,
// source-span diagnostics, negotiated capabilities, and semantic conformance.
import { compileFormula, formulaRuntime, type FormulaPlan, type FormulaValue } from "../../packages/core/src/formula";

import { boxSummary, histogramEdges, histogramCounts } from "./metric-distributions";

const fields = [
  { name: "useful_ms", type: "number" as const },
  { name: "total_ms", type: "number" as const },
  { name: "platform", type: "text" as const },
  { name: "worker", type: "text" as const },
  { name: "overall", type: "text" as const },
  { name: "job_name", type: "text" as const },
  { name: "day", type: "datetime" as const },
];
type Row = Record<string, FormulaValue>;
const platforms = ["linux", "macos", "windows", "android", "freebsd"];
// Row order models the committed table's effective sort. The shown page is
// exactly the first 100 logical rows, not an aggregation preview sample.
const rows: Row[] = Array.from({ length: 12840 }, (_, i) => {
  const p = i < 100 ? i % 3 : (i * 7) % 5;
  const total = p === 4 ? 0 : 1000 + (i * 31) % 8000;
  const fraction = [0.86, 0.74, 0.61, 0.91, 0][p]! - (i % 11) / 100 + (3 - (i * 13) % 7) * 0.025;
  return { id: i + 1, day: `2026-10-${String(1 + (i * 13) % 7).padStart(2, "0")}T00:00:00Z`, platform: platforms[p]!, worker: `worker-${i % 4 + 1}`, useful_ms: Math.round(total * fraction), total_ms: total,
    overall: i % 9 === 0 ? "FAIL" : "PASS", job_name: `${i % 4 === 0 ? "build" : "test"}-${i % 30}` };
});

function quotedEnd(source: string, start: number, field: boolean) {
  for (let i = start + 1; i < source.length; i++) {
    if (!field && source[i] === "\\") { i++; continue; }
    if (source[i] === (field ? "]" : '"')) {
      if (field && source[i + 1] === "]") { i++; continue; }
      return i + 1;
    }
  }
  throw new Error(field ? "Unclosed field reference." : "Unclosed string.");
}
function compileMetric(source: string) {
  if (source.length > 10000) throw new Error("Formula is too long.");
  const leaves: Array<{ name: string; text: string; input: FormulaPlan | null; id: string }> = [];
  let scalar = "", i = 0;
  while (i < source.length) {
    if (source[i] === '"' || source[i] === "[") {
      const end = quotedEnd(source, i, source[i] === "[");
      scalar += source.slice(i, end); i = end; continue;
    }
    const call = source.slice(i).match(/^(SUM|AVG|MIN|MAX|COUNT_DISTINCT|COUNT)\s*\(/i);
    if (!call || (i > 0 && /[\w]/.test(source[i - 1]!))) { scalar += source[i++]; continue; }
    const start = i + call[0].length;
    let end = start, depth = 1;
    for (; end < source.length && depth; end++) {
      if (source[end] === '"' || source[end] === "[") { end = quotedEnd(source, end, source[end] === "[") - 1; continue; }
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
    }
    if (depth) throw new Error("Unclosed aggregate call.");
    const name = call[1]!.toUpperCase(), arg = source.slice(start, end - 1).trim();
    if (!arg && name !== "COUNT") throw new Error(`${name} needs a row expression.`);
    const input = arg ? compileFormula(arg, fields) : null;
    if ((name === "SUM" || name === "AVG") && input && input.type !== "number" && input.type !== "null") throw new Error(`${name} requires numeric input.`);
    const text = source.slice(i, end);
    let leaf = leaves.find(l => l.text === text);
    if (!leaf) { leaf = { name, text, input, id: `reduction_${leaves.length}` }; leaves.push(leaf); }
    if (leaves.length > 20) throw new Error("Prototype supports at most 20 aggregate terms.");
    scalar += `[${leaf.id}]`; i = end;
  }
  if (!leaves.length) throw new Error("A metric needs an aggregate such as SUM([useful_ms]) or COUNT().");
  const outer = compileFormula(scalar, leaves.map(l => ({ name: l.id, type: l.name === "MIN" || l.name === "MAX" ? l.input!.type === "null" ? "number" : l.input!.type : "number" })));
  if (outer.type === "textarray") throw new Error("Metric results must be scalar.");
  return { leaves, outer };
}

function hasRegex(node: FormulaPlan["ast"]): boolean {
  return node.kind === "call" && (node.name.startsWith("REGEX_") || node.args.some(hasRegex));
}
const serverCalls = new Set(["unary:+","unary:-","op:+","op:-","op:*","op:/","op:=","op:!=","op:<>","op:<","op:>","op:<=","op:>=","op:AND","op:OR","op:NOT","IF","NULLIF","COALESCE","IS_NULL","ABS"]);
function unsupportedServerCall(node: FormulaPlan["ast"]): string | undefined {
  if (node.kind !== "call") return undefined;
  if (!serverCalls.has(node.name)) return node.name;
  for (const arg of node.args) { const unsupported = unsupportedServerCall(arg); if (unsupported) return unsupported; }
  return undefined;
}
self.onmessage = (event) => {
  const { source, scope, groupBy, kind, direction, display, sourceY, rowSource, boxWhiskers, histogramBins } = event.data;
  try {
    if (kind === "select") {
      const plan = compileFormula(source, fields);
      const unsupported = unsupportedServerCall(plan.ast);
      if (unsupported) throw new Error(`${unsupported} is browser-only in the initial server profile. Global remote sorting is unavailable.`);
      // This models the proposed server order with a complete local dataset.
      // It is deliberately not a claim that a server endpoint exists.
      const evaluated = rows.map(row => ({ ...row, id:Number(row.id), computed: formulaRuntime(plan.ast, row) }));
      evaluated.sort((a,b) => {
        if (!!a.computed.error !== !!b.computed.error) return a.computed.error ? 1 : -1;
        const av = a.computed.value, bv = b.computed.value;
        if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
        const valueSort = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return valueSort * (direction === "asc" ? 1 : -1) || a.id - b.id;
      });
      self.postMessage({ rows:evaluated.slice(0,100), totalRows:rows.length, source, direction });
      return;
    }
    const distribution = display === "box" || display === "histogram";
    const rowPlan = distribution ? compileFormula(rowSource || "[total_ms]", fields) : null;
    if (rowPlan && rowPlan.type !== "number" && rowPlan.type !== "null") throw Error("A distribution needs a numeric row expression, such as [total_ms].");
    if (rowPlan && scope !== "shownRows" && hasRegex(rowPlan.ast)) {
      self.postMessage({ error: "Regex is available on shown rows only. Choose Shown rows to run this expression.", code: "regex_scope" }); return;
    }
    const plan = distribution ? null : compileMetric(source);
    const yPlan = display === "scatter" ? compileMetric(sourceY || "") : null;
    if (scope !== "shownRows" && [...(plan ? [plan] : []), ...(yPlan ? [yPlan] : [])].some(p => hasRegex(p.outer.ast) || p.leaves.some(l => l.input && hasRegex(l.input.ast)))) {
      self.postMessage({ error:"Regex is available on shown rows only. Choose Shown rows to run this expression.", code:"regex_scope" });
      return;
    }
    const inputRows = scope === "shownRows" ? rows.slice(0, 100) : rows;
    const groups = new Map<string, { keys: FormulaValue[]; rows: Row[] }>();
    if (!groupBy.length) groups.set("[]", { keys: [], rows: [] });
    for (const row of inputRows) {
      const keys = groupBy.map((f: string) => row[f] ?? null), id = JSON.stringify(keys);
      if (!groups.has(id)) groups.set(id, { keys, rows: [] });
      groups.get(id)!.rows.push(row);
    }
    if (rowPlan) {
      const evaluated = [...groups.values()].map(group => {
        const values: number[] = []; let nullCount = 0, error: string | undefined;
        for (const row of group.rows) {
          const result = formulaRuntime(rowPlan.ast, row);
          if (result.error) { error = `Distribution input error: ${result.error}`; break; }
          if (result.value === null) { nullCount++; continue; }
          if (typeof result.value !== "number" || !Number.isFinite(result.value)) { error = "Distribution input must be finite numeric values."; break; }
          values.push(result.value);
        }
        return { keys: group.keys, count: group.rows.length, values: error ? [] : values, nullCount, error };
      });
      const failed = evaluated.find(group => group.error);
      if (display === "histogram" && failed) throw Error(`Histogram cannot build complete bin edges: ${failed.error}`);
      const edges = display === "histogram" ? histogramEdges(evaluated.flatMap(g => g.values), histogramBins ?? 10) : [];
      if (display === "box" && boxWhiskers !== undefined && !["minmax", "tukey"].includes(boxWhiskers)) throw Error("Choose a supported whisker rule.");
      const buckets = evaluated.map(group => {
        const summary = boxSummary(group.values, boxWhiskers || "minmax");
        const distributionResult = display === "box" ? { kind: "box", summary } : { kind: "histogram", edges, counts: histogramCounts(group.values, edges), n: group.values.length };
        const components = summary ? ["min", "q1", "median", "q3", "max", "mean"].map(key => ({ expression: key, value: summary[key as "min" | "q1" | "median" | "q3" | "max" | "mean"] })) : [];
        return { keys: group.keys, count: group.count, nullCount: group.nullCount, error: group.error, value: summary?.median ?? null, components, distribution: distributionResult };
      });
      self.postMessage({ buckets, processedRows: inputRows.length, totalRows: rows.length, distributionMethod: "exact-linear", sharedEdges: edges }); return;
    }
    const buckets = [...groups.values()].map(group => {
      function evaluate(plan: ReturnType<typeof compileMetric>) {
      const values: Record<string, FormulaValue> = {}, components: Array<{ expression: string; value: FormulaValue }> = [];
      let error: string | undefined;
      for (const leaf of plan.leaves) {
        const all: FormulaValue[] = [];
        for (const row of group.rows) {
          const result = leaf.input ? formulaRuntime(leaf.input.ast, row) : { value: 1 };
          if (result.error) { error = `Input error in ${leaf.text}: ${result.error}`; break; }
          all.push(result.value);
        }
        const nonNull = all.filter(v => v !== null);
        let value: FormulaValue = null;
        switch (leaf.name) {
          case "COUNT": value = leaf.input ? nonNull.length : group.rows.length; break;
          case "COUNT_DISTINCT": value = new Set(nonNull.map(v => JSON.stringify(v))).size; break;
          case "SUM": case "AVG": {
            const sum = nonNull.reduce<number>((s, v) => s + (v as number), 0);
            value = nonNull.length ? leaf.name === "AVG" ? sum / nonNull.length : sum : null; break;
          }
          case "MIN": case "MAX": {
            for (const item of nonNull) if (value === null || (leaf.name === "MIN" ? item! < value! : item! > value!)) value = item;
            break;
          }
        }
        values[leaf.id] = value; components.push({ expression: leaf.text, value });
      }
      const result = error ? { value: null, error } : formulaRuntime(plan.outer.ast, values);
      return { ...result, components };
      }
      const x = evaluate(plan!), y = yPlan ? evaluate(yPlan) : null;
      return { keys: group.keys, count: group.rows.length, ...x, ...(y ? { y: y.value, yError: y.error, yComponents: y.components } : {}) };
    });
    self.postMessage({ buckets, processedRows: inputRows.length, totalRows: rows.length });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
