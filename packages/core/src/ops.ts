// ops.ts — which operators a field type allows, and value coercion.
//
// Single source of truth for "what filters can I build on this field", shared by
// the QueryBuilder UI, the CellMenu quick-filters, and client-side applyQuery.
// The backend (backends/go) enforces the same matrix independently — never trust
// the client.
//
// Every value can be NULL, so `is_null`/`is_not_null` are available on EVERY
// type, including bool (design feedback).

import type { FilterOp, FieldType, FieldDef } from "./index";

const NULLITY: FilterOp[] = ["is_null", "is_not_null"];

/** Default operator set per type. A FieldDef.filter.ops overrides this. */
export const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  text: ["=", "!=", "contains", "starts_with", "ends_with", ...NULLITY],
  enum: ["=", "!=", ...NULLITY],
  number: ["=", "!=", ">", ">=", "<", "<=", ...NULLITY],
  datetime: ["=", "!=", ">", ">=", "<", "<=", ...NULLITY],
  bool: ["=", "!=", ...NULLITY],
  textarray: ["includes", ...NULLITY],
};

/** Operators that take no value (the value input is hidden). */
export const NULLARY_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>(NULLITY);

/** Effective operators for a field (its override, else the type default). */
export function opsForField(field: Pick<FieldDef, "type" | "filter">): FilterOp[] {
  return field.filter?.ops ?? OPS_BY_TYPE[field.type];
}

/** Whether an op is valid for a type per the default matrix (server mirror lives
 *  in Go opAllowed; keep them in lockstep). */
export function opAllowedForType(type: FieldType, op: FilterOp): boolean {
  return OPS_BY_TYPE[type].includes(op);
}

/** Coerce a raw string value to the type the field expects, for client-side
 *  comparison. Throws on invalid input (e.g. a non-numeric value on a number
 *  field) so callers can surface it rather than silently mis-filtering. */
export function coerceValue(type: FieldType, raw: string): string | number | boolean {
  switch (type) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`not a number: ${JSON.stringify(raw)}`);
      return n;
    }
    case "bool": {
      const v = raw.toLowerCase();
      if (v === "true" || v === "1" || v === "t") return true;
      if (v === "false" || v === "0" || v === "f") return false;
      throw new Error(`not a bool: ${JSON.stringify(raw)}`);
    }
    case "datetime": {
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) throw new Error(`not a datetime: ${JSON.stringify(raw)}`);
      return ms;
    }
    default:
      return raw;
  }
}
