import { isOrGroup, predicatesOf, type SetFilterMetadata, type SetFilterMode, type WhereTerm } from "./query";

/** Compile an explicitly identified editor into existing CNF predicates. */
export function createSetFilter(field: string, mode: SetFilterMode, values: string[], id: string): WhereTerm[] {
  const keys = [...new Set(values)];
  if (mode !== "empty" && keys.length === 0) return [];
  const includes = keys.map((value) => ({ field, op: "includes" as const, value }));
  let terms: WhereTerm[];
  if (mode === "empty") terms = [{ field, op: "is_null", value: "" }];
  else if (mode === "any") terms = includes.length === 1 ? includes : [{ any: includes }];
  else if (mode === "all") terms = includes;
  else terms = includes.map((clause) => ({ any: [{ field, op: "is_null", value: "" }, { ...clause, negated: true }] }));
  return terms.map((term) => ({ ...term, setFilter: { id, mode, values: mode === "empty" ? [] : [...keys] } }));
}

/** Remove presentation metadata at transport boundaries, including inner literals. */
export function stripSetFilter(term: WhereTerm): WhereTerm {
  const strip = ({ setFilter: _metadata, ...clause }: ReturnType<typeof predicatesOf>[number]) => clause;
  return isOrGroup(term) ? { any: term.any.map(strip) } : strip(term);
}

/** Only collapse explicitly marked, intact editor output. Never infer from predicates. */
export function readSetFilter(where: WhereTerm[], index: number): { field: string; metadata: SetFilterMetadata; count: number } | null {
  const term = where[index];
  const metadata = term?.setFilter;
  if (!term || !metadata || where[index - 1]?.setFilter?.id === metadata.id) return null;
  const field = predicatesOf(term)[0]?.field;
  if (!field) return null;
  const expected = createSetFilter(field, metadata.mode, metadata.values, metadata.id);
  if (expected.length === 0) return null;
  for (let offset = 0; offset < expected.length; offset++) {
    const actual = where[index + offset];
    if (!actual || JSON.stringify(actual.setFilter) !== JSON.stringify(expected[offset]!.setFilter) || JSON.stringify(stripSetFilter(actual)) !== JSON.stringify(stripSetFilter(expected[offset]!))) return null;
  }
  if (where[index + expected.length]?.setFilter?.id === metadata.id) return null;
  return { field, metadata, count: expected.length };
}

/** Canonicalize consumer-owned value aliases without disconnecting editor metadata. */
export function mapSetFilterValues(where: WhereTerm[], canonicalize: (field: string, value: string) => string): WhereTerm[] {
  const result: WhereTerm[] = [];
  for (let index = 0; index < where.length; index++) {
    const set = readSetFilter(where, index);
    if (!set) { result.push(where[index]!); continue; }
    result.push(...createSetFilter(set.field, set.metadata.mode, set.metadata.values.map((value) => canonicalize(set.field, value)), set.metadata.id));
    index += set.count - 1;
  }
  return result;
}
