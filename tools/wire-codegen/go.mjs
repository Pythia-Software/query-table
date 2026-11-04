// Go emitter: structs whose field order and json tags are the wire encoding.
import { execFileSync } from "node:child_process";
import { banner, codeEnum, escapeHatch, snakePascal, isObject, isStringEnum, nullable, pascal, properties, refName, scalarUnion, typeName, variants } from "./model.mjs";

const wrap = (text, indent) => {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length > 76 - indent.length) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}// ${l}\n`).join("");
};

export function emitGo(defs) {
  const type = (node, optional) => {
    if (node["x-go-type"]) return node["x-go-type"];
    if (node["x-go-repr"]) return node["x-go-repr"];
    if (node.$ref) {
      const name = refName(node), def = defs[name];
      if (escapeHatch(def, "go")) return (optional && isObject(def) ? "*" : "") + escapeHatch(def, "go");
      if (isObject(def)) return (optional ? "*" : "") + typeName(defs, name, "go");
      if (codeEnum(def)) return typeName(defs, name, "go");
      if (def.type === "string") return "string";
      if (scalarUnion(defs, def)) return "any";
      throw Error(`${name}: a union referenced from Go needs x-go-type.`);
    }
    if (node.const !== undefined) return typeof node.const === "number" ? "int" : "string";
    const inner = nullable(node);
    if (inner) return type(inner, true);
    if (variants(node)) {
      if (scalarUnion(defs, node)) return "any";
      throw Error("An inline union referenced from Go needs x-go-type.");
    }
    switch (node.type) {
      case "string": return "string";
      case "integer": return "int";
      case "number": return "float64";
      case "boolean": return "bool";
      case "array": return `[]${type(node.items)}`;
      case "object": return `map[string]${node.additionalProperties && Object.keys(node.additionalProperties).length ? type(node.additionalProperties) : "any"}`;
    }
    return "any";
  };
  let out = `${banner("//")}\n\npackage querytable\n\nimport "encoding/json"\n`;
  for (const [name, def] of Object.entries(defs)) {
    const codes = codeEnum(def);
    if (codes) {
      const go = typeName(defs, name, "go");
      out += "\n" + wrap(`${go}: ${def.description}`, "") + `type ${go} string\n\nconst (\n`;
      for (const { code, description } of codes) out += wrap(description, "\t") + `\t${go}${snakePascal(code)} ${go} = ${JSON.stringify(code)}\n`;
      out += ")\n";
      const byStatus = new Map();
      for (const { code, status } of codes) if (status !== null && status !== 400) byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
      out += `\n// HTTPStatus is the response status for the code: 400 unless x-codes says\n// otherwise (client-only codes are 400).\nfunc (c ${go}) HTTPStatus() int {\n\tswitch c {\n`;
      for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b))
        out += `\tcase ${list.map((code) => go + snakePascal(code)).join(",\n\t\t")}:\n\t\treturn ${status}\n`;
      out += `\t}\n\treturn 400\n}\n`;
      out += `\n// ${go}s lists every ${go} in schema order.\nfunc ${go}s() []${go} {\n\treturn []${go}{\n${codes.map(({ code }) => `\t\t${go}${snakePascal(code)},\n`).join("")}\t}\n}\n`;
      continue;
    }
    if (!isObject(def) || escapeHatch(def, "go") || isStringEnum(def)) continue;
    const go = typeName(defs, name, "go");
    out += "\n" + (def.description ? wrap(`${go}: ${def.description}`, "") : "") + `type ${go} struct {\n`;
    for (const { json, node, required } of properties(def)) {
      const omit = node["x-go-omit"] ?? (required ? "none" : "omitempty");
      if (node.description) out += wrap(node.description, "\t");
      // A required list or map is never null on the wire, even when Go's is
      // nil: WireList and WireMap encode nil as empty (see wire_list.go).
      let t = type(node, !required);
      if (required && !nullable(node)) t = t.replace(/^\[\](.+)$/, "WireList[$1]").replace(/^map\[string\](.+)$/, "WireMap[$1]");
      out += `\t${node["x-go-name"] ?? pascal(json)} ${t} \`json:"${json}${omit === "none" ? "" : "," + omit}"\`\n`;
    }
    for (const line of def["x-go-extra"] ?? []) out += `\t${line}\n`;
    out += "}\n";
  }
  return execFileSync("gofmt", [], { input: out, encoding: "utf8" });
}
