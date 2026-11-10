import type { CSSProperties } from "react";
import type { MetricValue } from "./metricTypes";
export type MetricToken =
  | "accent"
  | "text"
  | "muted"
  | "grid"
  | "surface"
  | "other"
  | "null"
  | "error";
export interface MetricTheme {
  layers?: ReadonlyArray<{ id: string; colors: ReadonlyArray<string> }>;
  dimensions?: Readonly<
    Record<
      string,
      {
        layer: string;
        domain?: ReadonlyArray<MetricValue>;
        overrides?: ReadonlyArray<{ value: MetricValue; color: string }>;
        identity?: string;
      }
    >
  >;
  tokens?: Partial<Record<MetricToken, string>>;
  /**
   * Group keys whose value colours a labelled mark drawn for a whole
   * multi-key group (bar, box, list), in priority order, matched by field
   * name or dimension `identity`. A group takes the first listed key's
   * override, domain slot or NULL colour, so, for example, one kind of event
   * keeps its colour on every repository's bar; other values take the next
   * colour no other value of that key uses in the chart. Groupings without a
   * listed field, and pie and ring slices, colour each whole key. A clause's
   * own `display.colorBy` takes precedence over this host default.
   */
  colorBy?: string | ReadonlyArray<string>;
}
export interface MetricClassNames {
  root?: string;
  metric?: string;
  title?: string;
  plot?: string;
  axis?: string;
  grid?: string;
  legend?: string;
  mark?: string;
}
const palette = [
  "#0969da",
  "#8250df",
  "#1a7f37",
  "#bf8700",
  "#bc4c00",
  "#cf4b8c",
];
export const typedMetricKey = (value: MetricValue | undefined): string =>
  value == null ? "null:" : `${typeof value}:${String(value)}`;
export const metricTupleKey = (values: readonly MetricValue[]): string =>
  JSON.stringify(values.map(typedMetricKey));
function hash(value: string): number {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++)
    n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  return n >>> 0;
}
function validColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[;{}<>\u0000-\u001f]/.test(value) &&
    !/url\s*\(/i.test(value)
  );
}
export function createMetricColorResolver(theme: MetricTheme = {}) {
  const layers = (theme.layers ?? [])
    .slice(0, 64)
    .map((l) => ({
      id: l.id,
      colors: l.colors.slice(0, 256).filter(validColor),
    }))
    .filter((l) => l.colors.length);
  const token = (name: MetricToken): string =>
    validColor(theme.tokens?.[name])
      ? theme.tokens![name]!
      : `var(--qt-metric-${name}, ${name === "accent" ? "var(--qt-accent, #0969da)" : name === "text" ? "var(--qt-text, #24292f)" : name === "muted" ? "var(--qt-muted, #68717d)" : name === "surface" ? "var(--qt-bg, #fff)" : name === "grid" ? "var(--qt-border-subtle, #eaeef2)" : name === "error" ? "#c23934" : name === "null" ? "#858585" : "#8c959f"})`;
  const layerColors = (field: string, identity: string) => {
    const dim = theme.dimensions?.[field];
    return (
      (
        layers.find((l) => l.id === dim?.layer) ??
        (dim ? undefined : layers[hash(identity) % layers.length])
      )?.colors ?? palette
    );
  };
  const override = (field: string, value: MetricValue) =>
    theme.dimensions?.[field]?.overrides
      ?.slice(0, 4096)
      .find(
        (o) =>
          typedMetricKey(o.value) === typedMetricKey(value) &&
          validColor(o.color),
      )?.color;
  const domainIndex = (field: string, value: MetricValue) =>
    theme.dimensions?.[field]?.domain
      ?.slice(0, 4096)
      .findIndex((v) => typedMetricKey(v) === typedMetricKey(value)) ?? -1;
  const identityOf = (field: string) => theme.dimensions?.[field]?.identity ?? field;
  const color = (field: string, value: MetricValue): string => {
    const pinned = override(field, value);
    if (pinned) return pinned;
    if (value === null) return token("null");
    const identity = identityOf(field),
      colors = layerColors(field, identity),
      index = domainIndex(field, value);
    return colors[
      (index >= 0 ? index : hash(`${identity}\0${typedMetricKey(value)}`)) %
        colors.length
    ]!;
  };
  /**
   * Stable colours for distinct values drawn together. Pinned values (an
   * override, a domain entry or NULL) resolve as `color`; values hashed into
   * the palette take the next colour no other value in `values` uses while the
   * palette has room, sorted by typed key so the result ignores arrival order.
   */
  const spread = <T,>(
    entries: ReadonlyArray<readonly [key: string, value: T]>,
    colors: readonly string[],
    preferred: (value: T) => number,
    reserved: Iterable<number> = [],
  ) => {
    const assigned = new Map<string, number>();
    let used = new Set<number>(reserved);
    for (const [key, value] of [...new Map(entries)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (used.size >= colors.length) used = new Set();
      let index = preferred(value);
      while (used.has(index)) index = (index + 1) % colors.length;
      used.add(index);
      assigned.set(key, index);
    }
    return assigned;
  };
  const colorBy = (
    typeof theme.colorBy === "string"
      ? [theme.colorBy]
      : Array.isArray(theme.colorBy)
        ? theme.colorBy.slice(0, 64)
        : []
  ).filter((field): field is string => typeof field === "string" && field.length > 0);
  /** The first candidate key among `fields`, by name or shared dimension identity. */
  const colorByIndex = (fields: readonly string[], preferred?: string) => {
    for (const name of preferred === undefined ? colorBy : [preferred, ...colorBy]) {
      const exact = fields.indexOf(name);
      if (exact >= 0) return exact;
      const shared = fields.findIndex((field) => identityOf(field) === name);
      if (shared >= 0) return shared;
    }
    return -1;
  };
  return {
    token,
    color,
    /**
     * Colours whole group keys drawn together. Single values resolve as
     * `color`. With `keyColors` (the default) and a colouring key among
     * `fields` (the clause's `colorBy` first, then the theme's; a name not
     * among `fields` is ignored), a tuple takes that key's colour: its
     * override, domain slot or NULL colour, and otherwise the next colour no
     * other value of that key in this chart uses. Without one, a tuple's
     * colour depends only on the theme and its values, except that tuples
     * sharing a chart take the next free colour rather than repeat one while
     * the palette has room.
     */
    tupleColors(
      fields: readonly string[],
      tuples: ReadonlyArray<readonly MetricValue[]>,
      options: { colorBy?: string | undefined; keyColors?: boolean | undefined } = {},
    ): (values: readonly MetricValue[]) => string {
      const single = (values: readonly MetricValue[]) => color(fields[0] ?? "", values[0] ?? null);
      const by = fields.length > 1 && options.keyColors !== false ? colorByIndex(fields, options.colorBy) : -1;
      if (by >= 0) {
        const field = fields[by]!,
          identity = identityOf(field),
          colors = layerColors(field, identity);
        const present = tuples.filter((values) => values.length > 1).map((values) => values[by] ?? null);
        const hashed = present.filter((v) => v !== null && !override(field, v) && domainIndex(field, v) < 0);
        const assigned = spread(
          hashed.map((v) => [typedMetricKey(v), v] as const),
          colors,
          (v) => hash(`${identity}\0${typedMetricKey(v)}`) % colors.length,
          present.filter((v) => v !== null && !override(field, v) && domainIndex(field, v) >= 0)
            .map((v) => domainIndex(field, v) % colors.length),
        );
        return (values) => {
          if (values.length <= 1) return single(values);
          const value = values[by] ?? null,
            index = assigned.get(typedMetricKey(value));
          return index === undefined ? color(field, value) : colors[index]!;
        };
      }
      const identity = fields.map(identityOf).join("\0");
      const colors = layerColors(fields[0] ?? "", identity);
      const preferred = (values: readonly MetricValue[]) =>
        hash(`${identity}\0${metricTupleKey(values)}`) % colors.length;
      const assigned = spread(
        tuples
          .filter((values) => values.length > 1 && values.some((v) => v !== null))
          .map((values) => [metricTupleKey(values), values] as const),
        colors,
        preferred,
      );
      return (values) => {
        if (values.length <= 1) return single(values);
        if (values.every((v) => v === null)) return token("null");
        return colors[assigned.get(metricTupleKey(values)) ?? preferred(values)]!;
      };
    },
  };
}
/**
 * Chart kinds whose marks each carry their own text label, so several groups
 * may share a key's colour: lists, bars and boxes. Pie and ring slices and
 * histogram series are told apart by colour alone and keep whole-key colours.
 */
export const metricKeyColored = (kind: string): boolean =>
  ["list", "bar-horizontal", "bar-vertical", "box"].includes(kind);
export function metricThemeStyle(theme?: MetricTheme): CSSProperties {
  const resolver = createMetricColorResolver(theme);
  const style: Record<string, string> = {};
  for (const name of [
    "accent",
    "text",
    "muted",
    "grid",
    "surface",
    "other",
    "null",
    "error",
  ] as const)
    if (validColor(theme?.tokens?.[name]))
      style[`--qt-metric-${name}`] = resolver.token(name);
  return style as CSSProperties;
}
