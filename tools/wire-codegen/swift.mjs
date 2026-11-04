// Swift emitter: Codable structs with explicit coding (so required nulls and
// present-null JSON values round-trip) and enums for unions.
import { banner, escapeHatch, isObject, isStringEnum, nullable, properties, refName, scalarUnion, typeName, variants } from "./model.mjs";

const comment = (text, indent) => text ? `${indent}/// ${text}\n` : "";
const lowerFirst = (s) => s.replace(/^./, (c) => c.toLowerCase());

export function emitSwift(defs) {
  const type = (node) => {
    if (node["x-swift-type"]) return node["x-swift-type"];
    if (node["x-swift-repr"]) return node["x-swift-repr"];
    if (node.$ref) {
      const name = refName(node), def = defs[name];
      if (escapeHatch(def, "swift")) return escapeHatch(def, "swift");
      if (def.type === "string") return "String";
      if (scalarUnion(defs, def)) return "JSONValue";
      return typeName(defs, name, "swift");
    }
    if (node.const !== undefined) return typeof node.const === "number" ? "Int" : "String";
    const inner = nullable(node);
    if (inner) return type(inner);
    if (variants(node)) {
      if (scalarUnion(defs, node)) return "JSONValue";
      throw Error("Inline unions need a $def.");
    }
    switch (node.type) {
      case "string": return "String";
      case "integer": return "Int";
      case "number": return "Double";
      case "boolean": return "Bool";
      case "array": return `[${type(node.items)}]`;
      case "object": return `[String: ${node.additionalProperties && Object.keys(node.additionalProperties).length ? type(node.additionalProperties) : "JSONValue"}]`;
    }
    return "JSONValue";
  };
  let out = `${banner("//")}\nimport Foundation\n`;
  for (const [name, def] of Object.entries(defs)) {
    if (escapeHatch(def, "swift") || def.type === "string") continue;
    const swift = typeName(defs, name, "swift");
    if (variants(def)) {
      if (scalarUnion(defs, def)) continue;
      const cases = variants(def).map((option) => ({ name: option["x-swift-case"] ?? lowerFirst(refName(option)), type: type(option) }));
      out += `\n${comment(def.description, "")}public enum ${swift}: Codable, Equatable, Sendable {\n`;
      for (const c of cases) out += `  case ${c.name}(${c.type})\n`;
      out += `  public init(from decoder: Decoder) throws {\n    let c = try decoder.singleValueContainer()\n`;
      for (const c of cases) out += `    if let v = try? c.decode(${c.type}.self) {\n      self = .${c.name}(v)\n      return\n    }\n`;
      out += `    throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid ${swift}")\n  }\n`;
      out += `  public func encode(to encoder: Encoder) throws {\n    var c = encoder.singleValueContainer()\n    switch self {\n`;
      for (const c of cases) out += `    case .${c.name}(let v): try c.encode(v)\n`;
      out += `    }\n  }\n}\n`;
      continue;
    }
    if (!isObject(def)) continue;
    const props = properties(def).map((p) => ({ ...p, swift: p.node["x-swift-name"] ?? p.json, type: type(p.node),
      nullable: !!nullable(p.node), constant: p.node.const }));
    const optionalType = (p) => p.required && !p.nullable ? p.type : `${p.type}?`;
    out += `\n${comment(def.description, "")}public struct ${swift}: Codable, Equatable, Sendable {\n`;
    for (const p of props) out += comment(p.node.description, "  ") + `  public var ${p.swift}: ${optionalType(p)}\n`;
    out += `  enum CodingKeys: String, CodingKey {\n`;
    for (const p of props) out += `    case ${p.swift}${p.swift === p.json ? "" : ` = "${p.json}"`}\n`;
    out += `  }\n`;
    if (def["x-swift-init"] !== false) {
      const params = props.filter((p) => p.constant === undefined).map((p) => {
        const fallback = p.node["x-swift-default"] ?? (!p.required || p.nullable ? "nil" : undefined);
        return `${p.swift}: ${optionalType(p)}${fallback !== undefined ? ` = ${fallback}` : ""}`;
      });
      out += `  public init(${params.join(", ")}) {\n`;
      for (const p of props) out += `    self.${p.swift} = ${p.constant !== undefined ? JSON.stringify(p.constant) : p.swift}\n`;
      out += `  }\n`;
    }
    out += `  public init(from decoder: Decoder) throws {\n    let c = try decoder.container(keyedBy: CodingKeys.self)\n`;
    for (const p of props) {
      const key = `forKey: .${p.swift}`;
      if (p.required && p.nullable) out += `    ${p.swift} = try c.decodeNil(${key}) ? nil : try c.decode(${p.type}.self, ${key})\n`;
      else if (p.required && p.type.startsWith("[String:")) out += `    // Go encodes a nil map as null.\n    ${p.swift} = try c.decodeIfPresent(${p.type}.self, ${key}) ?? [:]\n`;
      // x-swift-lenient: a required value some servers omit decodes as this.
      else if (p.required && p.node["x-swift-lenient"] !== undefined) out += `    ${p.swift} = try c.decodeIfPresent(${p.type}.self, ${key}) ?? ${p.node["x-swift-lenient"]}\n`;
      else if (p.required) out += `    ${p.swift} = try c.decode(${p.type}.self, ${key})\n`;
      else if (p.type === "JSONValue") out += `    ${p.swift} = c.contains(.${p.swift}) ? try c.decode(JSONValue.self, ${key}) : nil\n`;
      else out += `    ${p.swift} = try c.decodeIfPresent(${p.type}.self, ${key})\n`;
      if (typeof p.constant === "string") out += `    guard ${p.swift} == ${JSON.stringify(p.constant)} else {\n      throw DecodingError.dataCorruptedError(${key}, in: c, debugDescription: "Expected ${p.constant}")\n    }\n`;
    }
    out += `  }\n  public func encode(to encoder: Encoder) throws {\n    var c = encoder.container(keyedBy: CodingKeys.self)\n`;
    for (const p of props) {
      const key = `forKey: .${p.swift}`;
      if (p.required && p.nullable) out += `    if let v = ${p.swift} { try c.encode(v, ${key}) } else { try c.encodeNil(${key}) }\n`;
      else if (p.required) out += `    try c.encode(${p.swift}, ${key})\n`;
      else out += `    try c.encodeIfPresent(${p.swift}, ${key})\n`;
    }
    out += `  }\n}\n`;
  }
  return out;
}
