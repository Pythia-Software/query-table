// Run after npm ci: node native/macos/scripts/build-formula-runtime.mjs
// formula.ts has type-only imports, so no third-party JS runtime is bundled.
import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../../../", import.meta.url);
const source = await readFile(new URL("packages/core/src/formula.ts", root), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
// The browser can terminate its worker; native JSC cannot. Guard allocation in
// JOIN before the core's post-result size check (10k items × a 100k separator).
const allocationGuard = `
const originalJoin = Array.prototype.join;
Array.prototype.join = function(separator) {
  const sep = separator === undefined ? "," : String(separator);
  let length = Math.max(0, this.length - 1) * sep.length;
  for (let i = 0; i < this.length; i++) {
    if (this[i] !== null && this[i] !== undefined) length += String(this[i]).length;
    if (length > 100000) throw new Error("Text result exceeds 100,000 characters.");
  }
  return originalJoin.call(this, separator);
};
`;
const bridge = `
globalThis.qtFormula = function (raw) {
  try {
    const request = JSON.parse(raw);
    if (request.action === "compile") {
      const defs = request.definitions || [];
      const stack = new Set(request.editingID ? [request.editingID] : []);
      let expanded = 0;
      const resolve = name => {
        if (!name.startsWith("@computed/")) return undefined;
        const id = name.slice(10), def = defs.find(d => d.id === id);
        if (!def) throw new Error("Computed column unavailable: " + id);
        if (stack.has(id)) throw new Error("Circular computed-column reference: " + def.label);
        if (stack.size >= 20 || ++expanded > 100) throw new Error("Computed dependency graph is too large.");
        stack.add(id);
        try { return exports.compileFormula(def.expression.source, request.fields, resolve); }
        finally { stack.delete(id); }
      };
      const plan = exports.compileFormula(request.source, request.fields, resolve);
      let nodes = 0;
      const inspect = (node, depth = 0) => {
        if (++nodes > 5000 || depth > 50) throw new Error("Expanded formula exceeds native execution limits.");
        if (node.kind === "call") {
          if (node.name.startsWith("REGEX_")) throw new Error("Regex formulas require an interruptible runtime and are not supported by the native evaluator.");
          node.args.forEach(child => inspect(child, depth + 1));
        }
      };
      inspect(plan.ast);
      return JSON.stringify({ result: plan });
    }
    return JSON.stringify({ result: exports.formulaRuntime(request.plan.ast, request.row) });
  } catch (error) {
    return JSON.stringify({ error: String(error.message || error) });
  }
};
`;
await writeFile(new URL("native/macos/Sources/QueryTableFormula/Resources/formula-runtime.js", root),
  "// Generated from packages/core/src/formula.ts. Do not edit.\n(function () { const exports = {};\n" + allocationGuard + compiled + bridge + "\n})();\n");
