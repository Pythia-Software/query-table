// metricIntervals.ts — confidence intervals around ratio metrics.
//
// A metric with `interval` must be a ratio of two additive aggregates, such as
// COUNT_DISTINCT(IF([events]>0,[turn_id],NULL)) / COUNT_DISTINCT([turn_id]) or
// SUM([events]) / NULLIF(COUNT_DISTINCT([message_id]) / 1000, 0). Every engine
// reduces the numerator and denominator anyway; the bounds come from those
// exact parts, never from the rounded value, and are scaled like the value.
//
// - proportion: Wilson score interval for numerator successes out of
//   denominator trials (0 <= numerator <= denominator).
// - rate: exact (Garwood) Poisson interval for the numerator count, divided by
//   the denominator exposure: gamma quantiles at (1 - level) / 2 with shape
//   numerator, and at (1 + level) / 2 with shape numerator + 1.
//
// The Go executor (backends/go/metric_interval.go) implements the same
// recognizer and numerics; schema/fixtures/metric-intervals.json holds the
// shared cases every engine must reproduce.

import {
  FormulaError,
  type FormulaNode,
  type FormulaPlan,
  type FormulaResult,
} from "./formula";
import type { AggregationClause } from "./query";
import type { MetricInterval } from "./wire.generated";

export type { MetricInterval } from "./wire.generated";
export const DEFAULT_METRIC_INTERVAL_LEVEL = 0.95;

type Call = Extract<FormulaNode, { kind: "call" }>;
/** The parts of a ratio metric: value = scale × numerator / denominator. */
export interface MetricRatioParts {
  numerator: Call;
  denominator: Call;
  /** The product of the formula's constant factors; positive and finite. */
  scale: number;
}

const ADDITIVE = ["SUM", "COUNT", "COUNT_DISTINCT"];
const SHAPE =
  "An interval needs a ratio of two aggregates, such as COUNT_DISTINCT(IF(...)) / COUNT_DISTINCT(...) or SUM([events]) / NULLIF(COUNT([id]) / 1000, 0): one SUM, COUNT or COUNT_DISTINCT over another, multiplied or divided only by positive constants.";

/** The numerator, denominator and constant scale of a ratio metric. Throws a
 * FormulaError for any other shape. */
export function metricRatioParts(ast: FormulaNode): MetricRatioParts {
  const above: Call[] = [],
    below: Call[] = [];
  let scale = 1;
  const visit = (node: FormulaNode, up: boolean): void => {
    if (node.kind === "literal") {
      const value = node.value;
      if (typeof value !== "number" || !(value > 0) || !Number.isFinite(value))
        throw new FormulaError(SHAPE, node.from, node.to);
      scale = up ? scale * value : scale / value;
      return;
    }
    if (node.kind !== "call") throw new FormulaError(SHAPE, node.from, node.to);
    const name = node.name.toUpperCase();
    if (ADDITIVE.includes(name)) {
      (up ? above : below).push(node);
      return;
    }
    if (name === "OP:*" || name === "OP:/") {
      visit(node.args[0]!, up);
      visit(node.args[1]!, name === "OP:*" ? up : !up);
      return;
    }
    if (name === "UNARY:+") return visit(node.args[0]!, up);
    // NULLIF(x, 0) only turns a zero into no value, which has no interval.
    if (
      name === "NULLIF" &&
      node.args.length === 2 &&
      node.args[1]!.kind === "literal" &&
      node.args[1]!.value === 0
    )
      return visit(node.args[0]!, up);
    throw new FormulaError(SHAPE, node.from, node.to);
  };
  visit(ast, true);
  if (above.length !== 1 || below.length !== 1 || !Number.isFinite(scale) || !(scale > 0))
    throw new FormulaError(SHAPE, ast.from, ast.to);
  return { numerator: above[0]!, denominator: below[0]!, scale };
}

/** Throws a FormulaError when an interval option is malformed. */
export function validateMetricIntervalOption(interval: MetricInterval): void {
  if (
    !interval ||
    typeof interval !== "object" ||
    (interval.kind !== "proportion" && interval.kind !== "rate")
  )
    throw new FormulaError('An interval kind is "proportion" or "rate".');
  const level = interval.level;
  if (
    level !== undefined &&
    !(typeof level === "number" && level > 0 && level < 1)
  )
    throw new FormulaError("An interval level is between 0 and 1, such as 0.95.");
}

/** Throws a FormulaError when a clause's interval cannot be computed: the
 * metric must be a single value that is a ratio of two additive aggregates,
 * or a share (a proportion of its total). A window pools its parts first, so
 * only a window total qualifies. */
export function validateMetricInterval(
  c: Pick<AggregationClause, "interval" | "display" | "share" | "window" | "dateGrouping">,
  plan: FormulaPlan,
): void {
  if (c.interval === undefined) return;
  validateMetricIntervalOption(c.interval);
  if (!("aggregates" in plan) || c.display?.kind === "scatter")
    throw new FormulaError(
      "Intervals apply to single-value metrics, not distributions or scatters.",
    );
  if (c.dateGrouping?.occurrence)
    throw new FormulaError(
      "An occurrence mean has no interval: group by calendar intervals instead.",
    );
  if (c.window && (c.window.reduce ?? "total") !== "total")
    throw new FormulaError(
      "A mean per interval has no interval; a window total pools the counts and has one.",
    );
  if (c.share !== undefined) {
    if (c.interval.kind !== "proportion")
      throw new FormulaError(
        "A share is a proportion of its total: use a proportion interval.",
      );
    return; // validateMetricSeries requires a single SUM or COUNT.
  }
  metricRatioParts(plan.ast);
}

/** Set `lower` and `upper` on a bucket from its exact numerator and
 * denominator results. A bucket with an error or without a numeric value has
 * no interval; parts outside the kind's domain replace the value with an
 * error. */
export function applyMetricInterval(
  bucket: { value: unknown; error?: string; lower?: number; upper?: number },
  interval: MetricInterval,
  scale: number,
  numerator: FormulaResult | undefined,
  denominator: FormulaResult | undefined,
): void {
  if (
    bucket.error ||
    typeof bucket.value !== "number" ||
    !numerator ||
    !denominator ||
    numerator.error ||
    denominator.error ||
    typeof numerator.value !== "number" ||
    typeof denominator.value !== "number"
  )
    return;
  const bounds = metricIntervalBounds(
    interval,
    numerator.value,
    denominator.value,
    scale,
  );
  if (!bounds) return;
  if ("error" in bounds) {
    bucket.value = null;
    bucket.error = bounds.error;
    return;
  }
  bucket.lower = bounds.lower;
  bucket.upper = bounds.upper;
}

export type MetricIntervalBounds =
  | { lower: number; upper: number }
  | { error: string };

/** The interval of scale × numerator / denominator, or undefined when there
 * is none (a zero, missing or non-finite part). Parts outside the kind's
 * domain return an error: a proportion needs 0 <= numerator <= denominator,
 * a rate a nonnegative count over a positive exposure. */
export function metricIntervalBounds(
  interval: MetricInterval,
  numerator: number,
  denominator: number,
  scale = 1,
): MetricIntervalBounds | undefined {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return undefined;
  const alpha = 1 - (interval.level ?? DEFAULT_METRIC_INTERVAL_LEVEL);
  let lower: number, upper: number;
  if (interval.kind === "proportion") {
    if (numerator < 0 || denominator < 0 || numerator > denominator)
      return {
        error: `A proportion interval needs 0 ≤ numerator ≤ denominator; this group has ${numerator} of ${denominator}.`,
      };
    // Wilson score bounds, each from the stable root of the quadratic: the
    // lower one is p² / (p + z²/2n + d) and the upper one mirrors it.
    const z = normalQuantile(alpha),
      z2 = z * z,
      n = denominator,
      p = numerator / n,
      q = (n - numerator) / n;
    const spread = z * Math.sqrt((p * q) / n + z2 / (4 * n * n)),
      shift = z2 / (2 * n);
    lower = p === 0 ? 0 : (p * p) / (p + shift + spread);
    upper = q === 0 ? 1 : 1 - (q * q) / (q + shift + spread);
  } else {
    if (numerator < 0 || denominator < 0)
      return {
        error: `A rate interval needs a nonnegative count over a positive exposure; this group has ${numerator} over ${denominator}.`,
      };
    lower = numerator === 0 ? 0 : gammaQuantile(alpha / 2, numerator);
    upper = gammaQuantile(1 - alpha / 2, numerator + 1);
    lower /= denominator;
    upper /= denominator;
  }
  return { lower: scale * lower, upper: scale * upper };
}

/** The two-sided standard normal quantile for 1 - alpha: P(|Z| <= z) =
 * 1 - alpha, from the regularized gamma function with shape 1/2. */
export function normalQuantile(alpha: number): number {
  return Math.sqrt(2 * gammaQuantile(1 - alpha, 0.5));
}

// ---- Regularized incomplete gamma (Numerical Recipes, 3rd ed., 6.2) ---------

const EPS = 2.220446049250313e-16,
  FPMIN = Number.MIN_VALUE / EPS;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) sum += LANCZOS[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}
// 18-point Gauss-Legendre nodes and weights on [0, 1].
const GAUSS = (() => {
  const n = 18,
    nodes: number[] = [],
    weights: number[] = [];
  for (let i = 1; i <= n / 2; i++) {
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5)),
      derivative = 0;
    for (let step = 0; step < 100; step++) {
      let p1 = 1,
        p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      derivative = (n * (z * p1 - p2)) / (z * z - 1);
      const previous = z;
      z = previous - p1 / derivative;
      if (Math.abs(z - previous) <= 1e-15) break;
    }
    const weight = 1 / ((1 - z * z) * derivative * derivative);
    nodes[i - 1] = 0.5 - 0.5 * z;
    nodes[n - i] = 0.5 + 0.5 * z;
    weights[i - 1] = weights[n - i] = weight;
  }
  return { nodes, weights };
})();
/** P(a, x) by quadrature, for a >= 100 where the series and continued
 * fraction need O(√a) terms. */
function gammaPQuadrature(a: number, x: number): number {
  const a1 = a - 1,
    lna1 = Math.log(a1),
    root = Math.sqrt(a1);
  const xu =
    x > a1
      ? Math.max(a1 + 11.5 * root, x + 6 * root)
      : Math.max(0, Math.min(a1 - 7.5 * root, x - 5 * root));
  let sum = 0;
  for (let j = 0; j < GAUSS.nodes.length; j++) {
    const t = x + (xu - x) * GAUSS.nodes[j]!;
    sum += GAUSS.weights[j]! * Math.exp(-(t - a1) + a1 * (Math.log(t) - lna1));
  }
  const tail = sum * (xu - x) * Math.exp(a1 * (lna1 - 1) - logGamma(a));
  return tail > 0 ? 1 - tail : -tail;
}
/** The regularized lower incomplete gamma function P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (a >= 100) return gammaPQuadrature(a, x);
  const prefix = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    // Series.
    let ap = a,
      term = 1 / a,
      sum = term;
    for (let i = 0; i < 100000; i++) {
      ap++;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return sum * prefix;
  }
  // Continued fraction for Q(a, x), modified Lentz.
  let b = x + 1 - a,
    c = 1 / FPMIN,
    d = 1 / b,
    h = d;
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) <= EPS) break;
  }
  return 1 - prefix * h;
}
/** x such that P(a, x) = p: the p quantile of a Gamma(a, 1) distribution. */
export function gammaQuantile(p: number, a: number): number {
  if (!(a > 0) || !(p > 0 && p < 1)) throw Error("Invalid gamma quantile.");
  const a1 = a - 1,
    gln = logGamma(a);
  let x: number, lna1 = 0, afac = 0;
  if (a > 1) {
    lna1 = Math.log(a1);
    afac = Math.exp(a1 * (lna1 - 1) - gln);
    const pp = p < 0.5 ? p : 1 - p,
      t = Math.sqrt(-2 * Math.log(pp));
    let guess = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) guess = -guess;
    x = Math.max(
      1e-3,
      a * Math.pow(1 - 1 / (9 * a) - guess / (3 * Math.sqrt(a)), 3),
    );
  } else {
    const t = 1 - a * (0.253 + a * 0.12);
    x = p < t ? Math.pow(p / t, 1 / a) : 1 - Math.log(1 - (p - t) / (1 - t));
  }
  // Halley's method.
  for (let i = 0; i < 100; i++) {
    if (x <= 0) return 0;
    const error = gammaP(a, x) - p;
    const density =
      a > 1
        ? afac * Math.exp(-(x - a1) + a1 * (Math.log(x) - lna1))
        : Math.exp(-x + a1 * Math.log(x) - gln);
    const u = error / density;
    const step = u / (1 - 0.5 * Math.min(1, u * (a1 / x - 1)));
    x -= step;
    if (x <= 0) x = 0.5 * (x + step);
    if (Math.abs(step) <= 1e-12 * x) break;
  }
  return x;
}
