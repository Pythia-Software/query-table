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
  return {
    token,
    color(field: string, value: MetricValue): string {
      const dim = theme.dimensions?.[field],
        identity = dim?.identity ?? field;
      const override = dim?.overrides
        ?.slice(0, 4096)
        .find(
          (o) =>
            typedMetricKey(o.value) === typedMetricKey(value) &&
            validColor(o.color),
        );
      if (override) return override.color;
      if (value === null) return token("null");
      const colors =
        (
          layers.find((l) => l.id === dim?.layer) ??
          (dim ? undefined : layers[hash(identity) % layers.length])
        )?.colors ?? palette;
      const index =
        dim?.domain
          ?.slice(0, 4096)
          .findIndex((v) => typedMetricKey(v) === typedMetricKey(value)) ?? -1;
      return colors[
        (index >= 0 ? index : hash(`${identity}\0${typedMetricKey(value)}`)) %
          colors.length
      ]!;
    },
  };
}
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
