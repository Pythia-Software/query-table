// ops.ts — which operators a field type allows, and value coercion.
//
// Single source of truth for "what filters can I build on this field", shared by
// the QueryBuilder UI, the CellMenu quick-filters, and client-side applyQuery.
// The backend (backends/go) enforces the same matrix independently — never trust
// the client.
//
// Every value can be NULL, so `is_null`/`is_not_null` are available on EVERY
// type, including bool (design feedback).

import type { FilterOp, FieldType, FieldDef, WhereClause } from "./index";

const NULLITY: FilterOp[] = ["is_null", "is_not_null"];

/** Operators that are each other's logical complement. Negating one of these is
 *  a clean op flip (no NULL surprises the two ops don't already share), so the
 *  UI can render `≥ 10`'s negation as `< 10` rather than `NOT (≥ 10)`. Ops absent
 *  here (`contains`/`starts_with`/`ends_with`/`includes`) have no single-op
 *  complement and negate via the `WhereClause.negated` flag instead. */
const COMPLEMENT_OP: Partial<Record<FilterOp, FilterOp>> = {
  "=": "!=",
  "!=": "=",
  ">": "<=",
  "<=": ">",
  ">=": "<",
  "<": ">=",
  is_null: "is_not_null",
  is_not_null: "is_null",
  matches_regex: "not_matches_regex",
  not_matches_regex: "matches_regex",
};

/** The logical negation of a predicate. Prefers flipping to the complementary
 *  operator (nicer to read, and the server's op allowlist already covers it);
 *  falls back to toggling the `negated` flag when the op has no complement, or
 *  when the complement is not in `allowedOps` (a field's `filter.ops` override
 *  could disable it, and the server would reject a disabled op). `allowedOps`,
 *  when given, is the field's effective operator set from `opsForField`. */
export function negateClause(clause: WhereClause, allowedOps?: readonly FilterOp[]): WhereClause {
  const complement = COMPLEMENT_OP[clause.op];
  if (complement && (!allowedOps || allowedOps.includes(complement))) {
    const next: WhereClause = { field: clause.field, op: complement, value: clause.value };
    return next; // a complement fully expresses the negation; drop any stale flag
  }
  const next: WhereClause = { field: clause.field, op: clause.op, value: clause.value };
  if (!clause.negated) next.negated = true;
  return next;
}

/** Whether a predicate is negative — either an op that reads as a negation
 *  (`!=`, `not_matches_regex`, `is_not_null`) or one carrying the `negated`
 *  flag. Used to sort candidate filters into the CellMenu's two columns. */
export function isNegativePredicate(clause: Pick<WhereClause, "op" | "negated">): boolean {
  return Boolean(clause.negated) || clause.op === "!=" || clause.op === "not_matches_regex" || clause.op === "is_not_null";
}

/** A specific operator + negation state, e.g. `{ op: "<", negated: false }` or
 *  `{ op: "contains", negated: true }`. */
export interface OpChoice {
  op: FilterOp;
  negated: boolean;
}

/** A positive operator ("keep") and its logical negation ("exclude") — the row
 *  shape rendered by both the CellMenu quick-filters and the WHERE operator
 *  picker, so the two read identically. */
export interface OpPair {
  keep: OpChoice;
  exclude: OpChoice;
}

/** Positive operators surfaced in the "keep" column, in display order. Each
 *  one's negation lands opposite via `negateClause`, so the pair covers
 *  `<`/`<=`/`!=`/`not_matches_regex` without listing them separately. */
const POSITIVE_OP_ORDER: FilterOp[] = ["=", ">", ">=", "contains", "starts_with", "ends_with", "matches_regex", "includes"];

/** The keep/exclude operator pairs offered for a field: each positive op with
 *  its negation opposite, then a nullity row (`is null`/`is not null`) when the
 *  field allows it. Derived from the field's effective op set and `negateClause`,
 *  so a `filter.ops` override narrows the offered pairs too. */
export function opPairsForField(field: Pick<FieldDef, "type" | "filter">): OpPair[] {
  const ops = opsForField(field);
  const allow = new Set(ops);
  const pairs: OpPair[] = [];
  for (const op of POSITIVE_OP_ORDER) {
    if (!allow.has(op)) continue;
    const neg = negateClause({ field: "", op, value: "" }, ops);
    pairs.push({ keep: { op, negated: false }, exclude: { op: neg.op, negated: Boolean(neg.negated) } });
  }
  if (allow.has("is_null") || allow.has("is_not_null")) {
    pairs.push({ keep: { op: "is_null", negated: false }, exclude: { op: "is_not_null", negated: false } });
  }
  return pairs;
}

/** Default operator set per type. A FieldDef.filter.ops overrides this. */
export const OPS_BY_TYPE: Record<FieldType, FilterOp[]> = {
  text: [
    "=",
    "!=",
    "contains",
    "starts_with",
    "ends_with",
    "matches_regex",
    "not_matches_regex",
    ...NULLITY,
  ],
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
