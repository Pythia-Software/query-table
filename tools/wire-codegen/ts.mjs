// TypeScript emitter: interfaces, string-literal unions and union aliases.
import { banner, codeEnum, constantList, isObject, nullable, properties, refName, typeName, variants } from "./model.mjs";

const comment = (text, indent = "") => text ? `${indent}/** ${text.replace(/\*\//g, "*\\/")} */\n` : "";

export function emitTs(defs) {
  const type = (node) => {
    if (node["x-ts-type"]) return node["x-ts-type"];
    if (node.$ref) {
      const def = defs[refName(node)];
      return def["x-ts-type"] ?? (def.type === "string" && !def.enum ? "string" : typeName(defs, refName(node), "ts"));
    }
    if (node.const !== undefined) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
    const inner = nullable(node);
    if (inner) return `${type(inner)} | null`;
    if (variants(node)) return variants(node).map(type).join(" | ");
    switch (node.type) {
      case "string": return "string";
      case "integer": case "number": return "number";
      case "boolean": return "boolean";
      case "null": return "null";
      case "array": { const item = type(node.items); return /[ |]/.test(item) ? `(${item})[]` : `${item}[]`; }
      case "object":
        if (node.properties) throw Error("Inline objects need a $def.");
        return `Record<string, ${node.additionalProperties && Object.keys(node.additionalProperties).length ? type(node.additionalProperties) : "unknown"}>`;
    }
    return "unknown";
  };
  let out = `${banner("//")}\n// Wire types of the v3 query protocol. Public names are re-exported from the\n// hand-written modules (queryV3.ts, encode.ts, query.ts, ...).\n`;
  for (const [name, def] of Object.entries(defs)) {
    if (def["x-ts-type"] || (def.type === "string" && !def.enum)) continue;
    const ts = typeName(defs, name, "ts");
    out += "\n" + comment(def.description);
    const codes = codeEnum(def);
    if (codes) {
      const list = constantList(name);
      out += `export const ${list} = [\n${codes.map(({ code }) => `  ${JSON.stringify(code)},\n`).join("")}] as const;\n` +
        `export type ${ts} = (typeof ${list})[number];\n`;
    } else if (isObject(def)) {
      out += `export interface ${ts} {\n`;
      for (const { json, node, required } of properties(def))
        out += comment(node.description, "  ") +
          `  ${/^[A-Za-z_$][\w$]*$/.test(json) ? json : JSON.stringify(json)}${required ? "" : "?"}: ${type(node)};\n`;
      out += "}\n";
    } else out += `export type ${ts} = ${type(def)};\n`;
  }
  return out;
}
