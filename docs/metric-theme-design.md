# Metric theme and category color proposal

> Design reference preserved from the approved prototype. Production APIs and current integration limits are documented in [Metrics](metrics.md) and [Backend metrics](backend-metrics.md).

Status: caller-facing API proposal and executable local prototype. No public package API has changed.

Use one theme/color resolver per query-table UI instance, shared by the metrics panel, metric editor, dashboard preview and all chart formats. A category's color is keyed by **canonical field identity + typed raw value**, never the metric ID, label, result rank, observed order, formatted value or chart kind. This makes Linux the same color in an OS bar, OS pie and platform × worker scatter, including when sorting or switching shown/all-row scope. Different fields containing the same text do not accidentally share identity. An upstream caller may explicitly alias field identities to a shared semantic dimension when separate datasets use different names for the same OS field.

The existing UI exports `MetricsPanel`, native selects and `TableClassNames`/`QueryBuilderClassNames`/`MenuClassNames`; `theme.css` uses `--qt-*` variables. Extend those escape hatches rather than introducing a chart library or a separate styling framework. Propose an optional `theme?: MetricTheme` on `MetricsPanelProps` and on the future metric-editor props, with the host passing the same object to both. A React provider can share one resolver when composition would otherwise require prop plumbing. Keep it instance-scoped, never a process-wide mutable registry.

```ts
type CategoryValue = string | number | boolean | null;
type MetricTheme = {
  layers?: ReadonlyArray<{
    id: string; // stable palette-set name, independent of array position
    colors: ReadonlyArray<string>; // CSS colors or var(--brand-token)
  }>;
  dimensions?: Readonly<Record<string, {
    layer: string;
    domain?: ReadonlyArray<CategoryValue>; // caller's stable categorical domain
    overrides?: ReadonlyArray<{ value: CategoryValue; color: string }>;
  }>>;
  tokens?: Partial<Record<
    "accent" | "text" | "muted" | "grid" | "surface" |
    "other" | "null" | "error", string>>;
  // Future numeric heatmaps use separate sequential/diverging scales,
  // not the categorical layer slots.
};
```

A palette layer is a set of colors designed to work together. A dimension selects a layer, then each member selects a color inside that layer. Independent breakdowns can use different sets while the same dimension always uses the same set. Example caller configuration:

```ts
const metricTheme: MetricTheme = {
  layers: [
    { id: "os", colors: ["var(--brand-blue)", "var(--brand-purple)",
      "var(--brand-green)", "var(--brand-gold)", "var(--brand-orange)"] },
    { id: "workers", colors: ["#007c91", "#598234", "#b36200", "#7e5bef"] },
    { id: "outcomes", colors: ["var(--qt-pass-fg)", "var(--qt-fail-fg)"] },
  ],
  dimensions: {
    platform: { layer: "os", domain: ["linux", "macos", "windows", "android", "freebsd"] },
    worker: { layer: "workers", domain: ["worker-1", "worker-2", "worker-3", "worker-4"] },
    overall: { layer: "outcomes", domain: ["PASS", "FAIL"] },
  },
  tokens: { accent: "var(--qt-accent)", surface: "var(--qt-metric-surface, #fff)",
    other: "var(--qt-metric-other, #8c959f)" },
};
// Proposed usage, not an API currently exported:
// <MetricsPanel api={api} theme={metricTheme} />
// <MetricEditor api={api} theme={metricTheme} />
```

Resolution order: exact typed category override → declared-domain index within its named layer → deterministic hash fallback. Missing dimensions choose a layer deterministically by field identity. Empty/invalid layers and unknown layer names use documented defaults. Validate and bound colors/domains at the UI boundary; colors never go into formula sources or SQL. Never allocate colors according to whichever response finishes first. A declared domain/override gives callers exact, predictable mappings; unknown categories remain stable under result sorting, filtering and refresh. Hash/cycling fallback can collide when the palette is small; no finite palette guarantees unique colors for unbounded categories. Keep labels/tooltips, accessible tables and optional marker patterns so color is never the sole identifier. Changing a declared domain's ordering intentionally changes assignments; consumers needing immutability should pin overrides or treat the domain as versioned theme configuration.

A temporal line represents one measure across time, so its whole series uses the accent token rather than recoloring each day. Categorical bars, pie/donut slices, list swatches and scatter points use the same resolver. For multikey charts, persist the selected color grouping by stable group ID; default to the first categorical grouping at creation, not on every reorder. Removing that grouping prompts an explicit presentation fallback. An additive Other slice uses the reserved `other` token, distinct from a real category named Other. NULL keys use `null`; errors use `error`. Numeric heatmap values need continuous scale domains and legends, not category colors. Negative bars keep the category color and communicate sign through the zero baseline.

Use CSS variables for chart chrome and existing QT text/accent/status tokens, with `classNames` slots for wrappers, titles, plot, axis text/grid, legends and marks. JSX/SVG should inherit those tokens rather than hardcoding a light background. Mirror the host's theme scope into portals, following `AdaptiveOverlay`'s inherited-variable approach; `rem` layout measures the document root, not the portal's local font size. CSS variable changes restyle marks directly; palette/domain changes re-resolve presentation and never invalidate aggregate computation caches. Keep caller theme config out of query-state/URL serialization: save semantic grouping/color-by IDs with the metric, while the host supplies brand presentation. Reusing the same theme across table instances gives cross-table consistency; one instance's edits must not mutate another's configuration.

The prototype implements this in [metric-colors.js](mockups/metric-colors.js), with `window.metricTheme` injection before script loading and `metricColors.setTheme(config)` for live experiments. That window API is only a mockup convenience; the production API should use per-instance props/context. The demo declares stable OS, worker and outcome domains, uses five distinct OS colors, and reserves PASS/FAIL colors from the existing QT status tokens. Renderer backgrounds, axes, grids and series accent accept CSS-variable tokens. Styling the rest of the modal continues through the existing QT theme/class-name contract in implementation.

Acceptance: identical OS values match across bars/pies/scatter under different sort/scope/limits; number `1`, text `"1"`, NULL and text `"null"` retain distinct identities; numeric/string comparisons are never inferred from labels. Verify custom layers and overrides, variable-based/dark themes, unknown values/layers, palette exhaustion, semantic Other versus a real Other value, shared-instance consistency and instance isolation. Theme changes issue no new aggregate requests and require no new runtime dependencies.
