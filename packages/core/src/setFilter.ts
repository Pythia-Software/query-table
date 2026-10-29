import { isWhereConjunction, isWhereGroup, predicatesOf, type SetFilterMetadata, type SetFilterMode, type WhereBranch, type WhereTerm } from "./query";
import { filterValues, type FieldDef } from "./schema";

/** What a set editor compiles to: array membership (`includes`) for textarray
 *  fields, or scalar equality (`=` / `!=`) for enum and static-option text fields. */
export type SetFilterTarget = "array" | "scalar";

/** The set editor a field opted into with `filter.editor: "set"`, or null.
 *  Text fields qualify only with static `filter.values.options`. */
export function setFilterTarget(field: FieldDef): SetFilterTarget | null {
  if (field.filter?.editor !== "set") return null;
  if (field.type === "textarray") return "array";
  if (field.type === "enum" || (field.type === "text" && filterValues(field).source === "static")) return "scalar";
  return null;
}

/** Modes a target supports. ALL and EMPTY describe arrays; a scalar holds one value. */
export function setFilterModes(target: SetFilterTarget): SetFilterMode[] {
  return target === "array" ? ["any", "all", "none", "empty"] : ["any", "none"];
}

/** Compile an explicitly identified editor into existing CNF predicates.
 *  Scalar NONE keeps NULL rows: one `(is_null OR != v)` group per value, because
 *  a bare `!=` is null-exclusive. */
export function createSetFilter(field: string, mode: SetFilterMode, values: string[], id: string, target: SetFilterTarget = "array"): WhereTerm[] {
  if (!setFilterModes(target).includes(mode)) throw new Error(`${mode.toUpperCase()} set filters require a textarray field.`);
  const keys = [...new Set(values)];
  if (mode !== "empty" && keys.length === 0) return [];
  const members = keys.map((value) => ({ field, op: target === "array" ? "includes" as const : "=" as const, value }));
  const isNull = { field, op: "is_null" as const, value: "" };
  let terms: WhereTerm[];
  if (mode === "empty") terms = [isNull];
  else if (mode === "any") terms = members.length === 1 ? members : [{ any: members }];
  else if (mode === "all") terms = members;
  else terms = members.map((clause) => ({ any: [isNull, target === "array" ? { ...clause, negated: true } : { ...clause, op: "!=" as const }] }));
  return terms.map((term) => ({ ...term, setFilter: { id, mode, values: mode === "empty" ? [] : [...keys] } }));
}

/** Remove presentation metadata at transport boundaries, including inner literals. */
export function stripSetFilter(term: WhereTerm): WhereTerm {
  const strip = ({ setFilter: _metadata, ...clause }: ReturnType<typeof predicatesOf>[number]) => clause;
  if (!isWhereGroup(term)) return strip(term);
  return { any: term.any.map((member: WhereBranch) => isWhereConjunction(member) ? { all: member.all.map(strip) } : strip(member)) } as WhereTerm;
}

/** Only collapse explicitly marked, intact editor output. Never infer from predicates. */
export function readSetFilter(where: WhereTerm[], index: number): { field: string; metadata: SetFilterMetadata; count: number; target: SetFilterTarget } | null {
  const term = where[index];
  const metadata = term?.setFilter;
  if (!term || !metadata || where[index - 1]?.setFilter?.id === metadata.id) return null;
  const field = predicatesOf(term)[0]?.field;
  if (!field) return null;
  // The compiled operator distinguishes the two shapes; the exact comparison
  // below still rejects anything the compiler would not have produced.
  const target: SetFilterTarget = predicatesOf(term).some((clause) => clause.op === "includes") || !setFilterModes("scalar").includes(metadata.mode) ? "array" : "scalar";
  const expected = createSetFilter(field, metadata.mode, metadata.values, metadata.id, target);
  if (expected.length === 0) return null;
  for (let offset = 0; offset < expected.length; offset++) {
    const actual = where[index + offset];
    if (!actual || JSON.stringify(actual.setFilter) !== JSON.stringify(expected[offset]!.setFilter) || JSON.stringify(stripSetFilter(actual)) !== JSON.stringify(stripSetFilter(expected[offset]!))) return null;
  }
  if (where[index + expected.length]?.setFilter?.id === metadata.id) return null;
  return { field, metadata, count: expected.length, target };
}

/** Canonicalize consumer-owned value aliases without disconnecting editor metadata. */
export function mapSetFilterValues(where: WhereTerm[], canonicalize: (field: string, value: string) => string): WhereTerm[] {
  const result: WhereTerm[] = [];
  for (let index = 0; index < where.length; index++) {
    const set = readSetFilter(where, index);
    if (!set) { result.push(where[index]!); continue; }
    result.push(...createSetFilter(set.field, set.metadata.mode, set.metadata.values.map((value) => canonicalize(set.field, value)), set.metadata.id, set.target));
    index += set.count - 1;
  }
  return result;
}
