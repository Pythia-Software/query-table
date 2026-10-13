import type { MetricValueFormat } from "./metricTypes";
import type { FieldDef, FieldSchema } from "./schema";
import { readFieldValue } from "./schema";
import type { RowId } from "./query";
import { parseCellDisplay, type CellDisplay, type JsonCellDisplay } from "./cellDisplay";

/** Formats change presentation only; values retain their original types/units. */
export type PropertyFormat =
  | MetricValueFormat
  | { kind: "text" | "code" | "boolean" | "chips" }
  | JsonCellDisplay
  | Extract<CellDisplay, { kind: "chip" }>
  | {
      kind: "relative";
      sourceUnit?: "iso" | "epochSeconds" | "epochMilliseconds";
    }
  | { kind: "currency"; currency: string; decimals?: number };

export interface PropertyFieldConfig {
  enabled?: boolean;
  default?: boolean;
  /** Detail-specific renderer. Table renderers remain unchanged. */
  render?: string;
  format?: PropertyFormat;
}

export interface PropertySelection {
  /** Instance identity allows the same field to appear with different formats. */
  id: string;
  field: string;
  label?: string;
  render?: string;
  format?: PropertyFormat;
}

/** Independent of object identity and collection QueryState. [] shows no fields. */
export interface PropertyViewState {
  version: 1;
  properties: PropertySelection[];
  /** Property label column width as a percentage, shared with the saved view. */
  labelWidth?: number;
}

export const MAX_PROPERTIES = 200;
const string = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizePropertyFormat(
  input: unknown,
): PropertyFormat | undefined {
  if (!record(input)) return;
  const kind = input.kind;
  if (kind === "json" || kind === "chip") {
    try { return parseCellDisplay(input) as PropertyFormat; }
    catch { return; }
  }
  if (
    input.decimals !== undefined &&
    !(
      typeof input.decimals === "number" &&
      Number.isInteger(input.decimals) &&
      input.decimals >= 0 &&
      input.decimals <= 20
    )
  )
    return;
  if (["text", "code", "boolean", "chips"].includes(String(kind)))
    return { kind } as PropertyFormat;
  if (kind === "relative") {
    if (
      input.sourceUnit !== undefined &&
      !["iso", "epochSeconds", "epochMilliseconds"].includes(
        String(input.sourceUnit),
      )
    )
      return;
    return {
      kind,
      ...(input.sourceUnit ? { sourceUnit: input.sourceUnit } : {}),
    } as PropertyFormat;
  }
  if (kind === "currency") {
    if (
      typeof input.currency !== "string" ||
      !/^[A-Z]{3}$/.test(input.currency)
    )
      return;
    return {
      kind,
      currency: input.currency,
      ...(typeof input.decimals === "number" &&
      Number.isInteger(input.decimals) &&
      input.decimals >= 0 &&
      input.decimals <= 20
        ? { decimals: input.decimals }
        : {}),
    };
  }
  if (
    !["number", "percent", "duration", "date", "time", "datetime"].includes(
      String(kind),
    )
  )
    return;
  if (
    input.sourceUnit !== undefined &&
    ![
      "milliseconds",
      "seconds",
      "minutes",
      "hours",
      "days",
      "iso",
      "epochSeconds",
      "epochMilliseconds",
      "secondsOfDay",
      "millisecondsOfDay",
    ].includes(String(input.sourceUnit))
  )
    return;
  if (
    input.style !== undefined &&
    !["human", "long", "clock", "custom", "iso"].includes(String(input.style))
  )
    return;
  if (input.pattern !== undefined && !string(input.pattern, 1000)) return;
  if (input.timeZone !== undefined && !string(input.timeZone)) return;
  const out: Record<string, unknown> = { kind };
  if (
    typeof input.decimals === "number" &&
    Number.isInteger(input.decimals) &&
    input.decimals >= 0 &&
    input.decimals <= 20
  )
    out.decimals = input.decimals;
  if (
    [
      "milliseconds",
      "seconds",
      "minutes",
      "hours",
      "days",
      "iso",
      "epochSeconds",
      "epochMilliseconds",
      "secondsOfDay",
      "millisecondsOfDay",
    ].includes(String(input.sourceUnit))
  )
    out.sourceUnit = input.sourceUnit;
  if (["human", "long", "clock", "custom", "iso"].includes(String(input.style)))
    out.style = input.style;
  if (string(input.pattern, 1000)) out.pattern = input.pattern;
  if (string(input.timeZone)) out.timeZone = input.timeZone;
  return out as unknown as PropertyFormat;
}

/** Strict envelope/version checks prevent interpreting future saved views as empty. */
export function normalizePropertyView(input: unknown): PropertyViewState {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.properties))
    throw new Error(
      "Unsupported or invalid property view (expected version 1).",
    );
  if (input.properties.length > MAX_PROPERTIES)
    throw new Error(`At most ${MAX_PROPERTIES} properties are allowed.`);
  const ids = new Set<string>();
  const properties = input.properties.map((item): PropertySelection => {
    if (
      !record(item) ||
      !string(item.id) ||
      !string(item.field) ||
      ids.has(item.id)
    )
      throw new Error("Property fields and unique instance IDs are required.");
    ids.add(item.id);
    const property: PropertySelection = { id: item.id, field: item.field };
    if (string(item.label, 1000)) property.label = item.label;
    if (string(item.render)) property.render = item.render;
    if (item.format !== undefined) {
      const format = normalizePropertyFormat(item.format);
      if (!format) throw new Error(`Invalid format for property ${item.id}.`);
      property.format = format;
    }
    return property;
  });
  const labelWidth = typeof input.labelWidth === "number" && Number.isFinite(input.labelWidth)
    ? Math.max(15, Math.min(75, Math.round(input.labelWidth))) : undefined;
  return { version: 1, properties, ...(labelWidth !== undefined ? { labelWidth } : {}) };
}

export function createPropertyView<Row>(
  schema: FieldSchema<Row>,
  names?: string[],
): PropertyViewState {
  const enabled = schema.fields.filter((f) => f.property?.enabled !== false);
  const hasPropertyDefaults = enabled.some(
    (f) => f.property?.default !== undefined,
  );
  const defaults = hasPropertyDefaults
    ? enabled.filter((f) => f.property?.default).map((f) => f.name)
    : (schema.defaultSelect?.map((column) => column.field) ??
      enabled.filter((f) => f.select?.default).map((f) => f.name));
  const fields =
    names ??
    (hasPropertyDefaults || defaults.length
      ? defaults.filter((name) => enabled.some((field) => field.name === name))
      : enabled.map((f) => f.name));
  return normalizePropertyView({
    version: 1,
    properties: fields.map((field, i) => ({ id: `property-${i}`, field })),
  });
}

export interface FieldOrigin {
  table: string;
  column: string;
}
/** Backend discovery groups composite key columns in constraint order. */
export interface ForeignKey {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
}
export interface ObjectTypeDefinition {
  name: string;
  table: string;
  keyFields: string[];
}
export interface FieldRelationship {
  objectType: string;
  /** Target key field -> local catalogue field, including composite keys. */
  key: Record<string, string>;
}
export interface ObjectReference {
  objectType: string;
  key: Record<string, RowId>;
}
export interface ResolvedObjectReference {
  reference: ObjectReference;
  label?: string;
  href?: string;
}
/** Hosts resolve a batch through their authorized APIs, and own application routes. */
export interface RelationshipAdapter {
  resolve(
    references: ObjectReference[],
    signal?: AbortSignal,
  ): Promise<ResolvedObjectReference[]>;
}
export function objectReferenceKey(reference: ObjectReference): string {
  return JSON.stringify([
    reference.objectType,
    Object.entries(reference.key).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function readObjectReference<Row>(
  field: FieldDef<Row>,
  fields: FieldDef<Row>[],
  row: Row,
): ObjectReference | null {
  const relationship = field.relationship;
  if (!relationship) return null;
  const key: Record<string, RowId> = Object.create(null);
  for (const [target, local] of Object.entries(relationship.key)) {
    const source = fields.find((f) => f.name === local);
    if (!source) return null;
    const value = readFieldValue(source, row);
    if (
      !(
        (typeof value === "string" && value !== "") ||
        (typeof value === "number" && Number.isFinite(value))
      )
    )
      return null;
    key[target] = value as RowId;
  }
  return Object.keys(key).length
    ? { objectType: relationship.objectType, key }
    : null;
}

/** Only unambiguous, fully mapped constraints become links. Explicit metadata wins. */
export function discoverFieldRelationships<Row>(
  fields: FieldDef<Row>[],
  keys: ForeignKey[],
  types: ObjectTypeDefinition[],
): FieldDef<Row>[] {
  return fields.map((field) => {
    if (field.relationship || !field.origin) return field;
    const candidates: FieldRelationship[] = [];
    for (const fk of keys) {
      if (
        fk.sourceTable !== field.origin.table ||
        !fk.sourceColumns.includes(field.origin.column) ||
        fk.sourceColumns.length === 0 ||
        fk.sourceColumns.length !== fk.targetColumns.length
      )
        continue;
      const targets = types.filter(
        (type) =>
          type.table === fk.targetTable &&
          type.keyFields.length === fk.targetColumns.length &&
          type.keyFields.every((k) => fk.targetColumns.includes(k)),
      );
      if (targets.length !== 1) continue;
      const key: Record<string, string> = Object.create(null);
      let complete = true;
      fk.sourceColumns.forEach((column, i) => {
        const local = fields.filter(
          (f) =>
            f.origin?.table === fk.sourceTable && f.origin.column === column,
        );
        if (local.length !== 1) complete = false;
        else key[fk.targetColumns[i]!] = local[0]!.name;
      });
      if (complete) candidates.push({ objectType: targets[0]!.name, key });
    }
    return candidates.length === 1
      ? { ...field, relationship: candidates[0]! }
      : field;
  });
}
