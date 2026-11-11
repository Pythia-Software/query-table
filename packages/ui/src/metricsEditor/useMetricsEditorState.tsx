// State hook of the MetricsEditor: draft clauses, preview requests, diagnostics,
// navigation, and every editing action. The render functions in this directory
// read its return value; nothing here is module-level state.
import { metricPresentationProblem } from "../metricPresentation";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  validateMetricInterval,
  MAX_AGGREGATIONS,
  compileFormula,
  compileMetric,
  isGroupable,
  isMeasurable,
  metricComputationKey,
  metricExpression,
  metricMinCount,
  metricMinCountMeasure,
  type AggregationClause,
  type AggregationResult,
  type MetricDisplay,
  type MetricLayout,
  type MetricValueFormat,
  type MetricInterval,
  type MetricShare,
  type WhereTerm,
  FORMULA_FUNCTIONS,
} from "@pythia-software/query-table-core";
import { EditorPanelToggle, EditorPanelSeparator } from "../EditorModal";
import { MenuButton, MenuItem, MenuSeparator } from "../Menu";
import { MetricCard, cardDecimals } from "../MetricsPanel";
import { validateMetricFormat } from "../metricFormat";
import { useMetricWorkbench } from "../useMetricWorkbench";
import { useMetricResize } from "../useMetricResize";
import { type MetricsEditorProps } from "./types";
import {
  clone,
  fieldSource,
  defaultLayout,
  defaultProbabilities,
  panes,
  aggregateFunctions,
  titleOf,
  newId,
  SHARE_FORMAT,
  sameFormat,
  withoutIntervalDisplay,
} from "./shared";
import { MetricNumberInput } from "./controls";

/** All state, effects, actions and derived values of the metric editor.
 * Previews never mutate the table query; `apply` commits the draft. */
export function useMetricsEditorState<Row>({
  api,
  fields,
  onClose,
  initialMetricId,
  initialView = "editor",
  theme,
  locale,
}: MetricsEditorProps<Row>) {
  const titleId = useId();
  const initial = useRef(clone(api.aggregations.clauses));
  const initialKey = useRef(JSON.stringify(initial.current));
  const [drafts, setDrafts] = useState(initial.current);
  const [active, setActive] = useState(
    initialMetricId ?? initial.current[0]?.id ?? "",
  );
  const [view, setView] = useState<"editor" | "dashboard">(initialView);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [preview, setPreview] = useState<AggregationResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [canvas, setCanvas] = useState(1120);
  const [returnMetric, setReturnMetric] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{
    clause: AggregationClause;
    position: number;
  } | null>(null);
  const [openSettings, setOpenSettings] = useState<Record<string, boolean>>({});
  const settingsState = (title: string) => ({
    open: openSettings[title] ?? false,
    onOpenChange: (open: boolean) =>
      setOpenSettings((previous) =>
        previous[title] === open ? previous : { ...previous, [title]: open },
      ),
  });
  const geometryDrag = useMetricResize();
  const canvasElement = useRef<HTMLDivElement | null>(null);
  const focusDestination = useRef(false);
  const [navigation, setNavigation] = useState(0);
  const paneScroll = useRef([0, 0, 0, 0]);
  const [previewSize, setPreviewSize] = useState({ width: 320, height: 200 });
  const [formatTarget, setFormatTarget] = useState<"value" | "x" | "y">(
    "value",
  );
  const [reference, setReference] = useState<"fields" | "functions">("fields");
  const [referenceSearch, setReferenceSearch] = useState({
    fields: "",
    functions: "",
  });
  const search = referenceSearch[reference];
  const setSearch = (value: string) =>
    setReferenceSearch((previous) => ({ ...previous, [reference]: value }));
  const [concept, setConcept] = useState("all");
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [inputTarget, setInputTarget] = useState<"primary" | "secondary">(
    "primary",
  );
  const pendingInsertion = useRef<{
    id: string;
    text: string;
    wrap: boolean;
  } | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null),
    inputY = useRef<HTMLTextAreaElement | null>(null);
  const previewContainer = useRef<HTMLDivElement | null>(null);
  const workbench = useMetricWorkbench(view === "editor");
  const selected = drafts.find((c) => c.id === active);
  const chosen = selected?.display ?? { kind: "auto" as const };
  // A distribution reads a row formula, except a box over a slot's
  // occurrences, which summarises the metric itself.
  const rowInput =
    ["box", "histogram", "quantiles"].includes(chosen.kind) &&
    !selected?.dateGrouping?.occurrence;
  const dateField = fields.find(
    (f) => f.name === selected?.groupBy[0] && f.type === "datetime",
  );
  const dirty = JSON.stringify(drafts) !== initialKey.current;
  const contextChanged =
    JSON.stringify(api.aggregations.clauses) !== initialKey.current;
  const measurable = fields.filter(isMeasurable),
    groupable = fields.filter(isGroupable);
  const fieldLabel = (name: string) =>
    fields.find((f) => f.name === name)?.label ?? name;
  const compileRef = useRef(api.aggregations.compile);
  compileRef.current = api.aggregations.compile;
  const requestRef = useRef(api.aggregations.preview);
  requestRef.current = api.aggregations.preview;
  const draftRef = useRef(drafts);
  draftRef.current = drafts;
  const computationalKey = metricComputationKey(drafts);
  const queryContext = JSON.stringify([
    api.aggregations.contextKey,
    api.query.where,
    drafts.some((d) => d.scope === "shownRows")
      ? [api.query.orderBy, api.query.limit, api.query.offset, api.rows]
      : null,
  ]);
  const computationDiagnostics = useMemo(() => {
    const problems = new Map<string, string>();
    for (const c of drafts)
      try {
        if (compileRef.current) compileRef.current(c);
        else if (
          c.distribution &&
          !c.dateGrouping?.occurrence &&
          ["box", "histogram", "quantiles"].includes(c.display?.kind ?? c.distribution.kind)
        )
          compileFormula(c.distribution.input, fields);
        else {
          compileMetric(metricExpression(c), fields);
          if (c.display?.kind === "scatter")
            compileMetric(c.expressionY ?? "", fields);
        }
      } catch (e) {
        problems.set(c.id, e instanceof Error ? e.message : String(e));
      }
    return problems;
  }, [drafts, fields, api.aggregations.compile]);
  const diagnostics = useMemo(() => {
    const problems = new Map(computationDiagnostics);
    for (const c of drafts) {
      const presentationProblem = metricPresentationProblem(c);
      if (presentationProblem) problems.set(c.id, presentationProblem);
      if (c.label !== undefined && !c.label.trim())
        problems.set(c.id, "Enter a metric name.");
      for (const format of [
        c.display?.format,
        c.display?.xFormat,
        c.display?.yFormat,
      ])
        if (format) {
          const problem = validateMetricFormat(format);
          if (problem) problems.set(c.id, problem);
        }
    }
    return problems;
  }, [drafts, computationDiagnostics]);
  const diagnosticKey = JSON.stringify([...computationDiagnostics]);
  // Why each interval kind cannot apply to the selected metric (undefined when
  // it can), from the same validation that reports a chosen interval's issue.
  // Undefined while the metric itself does not compile: then nothing is known.
  const intervalReasons = useMemo(() => {
    if (!selected) return undefined;
    const check = (c: AggregationClause) => {
      if (compileRef.current) compileRef.current(c);
      else validateMetricInterval(c, compileMetric(metricExpression(c), fields));
    };
    const { interval: _interval, ...base } = selected;
    try {
      check(base);
    } catch {
      return undefined;
    }
    const reasons: Partial<Record<MetricInterval["kind"], string>> = {};
    for (const kind of ["proportion", "rate"] as const)
      try {
        check({ ...base, interval: { kind } });
      } catch (e) {
        reasons[kind] = e instanceof Error ? e.message : String(e);
      }
    return reasons;
  }, [selected, fields, api.aggregations.compile]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const executable = draftRef.current.filter(
      (c) => !computationDiagnostics.has(c.id),
    );
    if (!executable.length) {
      setPreviewLoading(false);
      setPreview(null);
      return;
    }
    if (!requestRef.current) {
      setPreviewLoading(false);
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreview(null);
    const timer = setTimeout(() => {
      void requestRef.current!(clone(executable), controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPreview(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    computationalKey,
    queryContext,
    diagnosticKey,
    retry,
    api.aggregations.preview,
  ]);

  useLayoutEffect(() => {
    setInspectOpen(false);
    setInspectedKey(null);
    pendingInsertion.current = null;
    if (!selected) return;
    const layout = selected.layout ?? defaultLayout;
    const rem =
      typeof document === "undefined"
        ? 16
        : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setPreviewSize({
      width: layout.widthRem * rem,
      height: layout.heightRem * rem,
    });
    setFormatTarget(
      ["scatter", "histogram"].includes(selected.display?.kind ?? "")
        ? "x"
        : "value",
    );
    // Selection affects geometry, not execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    const element = previewContainer.current;
    if (!element || typeof ResizeObserver === "undefined" || view !== "editor")
      return;
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0)
        setPreviewSize((previous) => {
          const next = {
            width: element.offsetWidth,
            height: element.offsetHeight,
          };
          return next.width === previous.width &&
            next.height === previous.height
            ? previous
            : next;
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view, !!selected]);

  useLayoutEffect(() => {
    if (view === "dashboard") {
      const card = Array.from(
        canvasElement.current?.querySelectorAll<HTMLElement>(
          "[data-metric-id]",
        ) ?? [],
      ).find((element) => element.dataset.metricId === active);
      card?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (focusDestination.current) {
        const target =
          card ??
          workbench.header.current
            ?.closest<HTMLElement>("[role=dialog]")
            ?.querySelector<HTMLElement>(".qt-metric-canvas-controls button");
        target?.focus({ preventScroll: true });
      }
    } else if (focusDestination.current) {
      const dialog =
        workbench.header.current?.closest<HTMLElement>("[role=dialog]");
      const selector = !selected
        ? ".qt-metric-create"
        : workbench.visiblePanes[1]
          ? '[aria-label="Metric name"]'
          : '[aria-label="Editing metric"]';
      const target = dialog?.querySelector<HTMLElement>(selector);
      if (selector === '[aria-label="Metric name"]') {
        const definition = target?.closest<HTMLElement>(
          ".qt-metric-definition",
        );
        if (definition) definition.scrollTop = 0;
        paneScroll.current[1] = 0;
      }
      if (target && !target.closest("[hidden]"))
        target.focus({ preventScroll: true });
      else
        dialog
          ?.querySelector<HTMLElement>('[aria-label="Metric list panel"]')
          ?.focus();
    }
    focusDestination.current = false;
  }, [view, active, navigation]);

  function navigate(destination: "editor" | "dashboard", id = active) {
    geometryDrag.stop();
    if (destination === "editor") workbench.showPane(1);
    focusDestination.current = true;
    setNavigation((previous) => previous + 1);
    setActive(id);
    setView(destination);
    setAnnouncement(
      destination === "dashboard"
        ? "Showing this metric in the dashboard draft."
        : "Editing the selected metric. Changes stay in this draft.",
    );
  }
  function seeInDashboard() {
    setReturnMetric(active);
    navigate("dashboard");
  }
  function createMetric() {
    if (drafts.length >= MAX_AGGREGATIONS) return;
    const c: AggregationClause = {
      id: newId(),
      op: "count",
      groupBy: [],
      label: "New metric",
      layout: { ...defaultLayout },
    };
    setDrafts((previous) => [...previous, c]);
    navigate("editor", c.id);
  }
  function canvasWidth(value: number) {
    if (Number.isFinite(value))
      setCanvas(Math.max(320, Math.min(2400, Math.round(value))));
  }
  function paneProps(index: number) {
    return {
      id: `${titleId}-pane-${index}`,
      hidden: !workbench.visiblePanes[index],
      ref: (element: HTMLElement | null) => {
        if (element) element.scrollTop = paneScroll.current[index] ?? 0;
      },
      onScroll: (e: React.UIEvent<HTMLElement>) => {
        paneScroll.current[index] = e.currentTarget.scrollTop;
      },
    };
  }
  function panelToggle(index: number, collapse = false) {
    const pane = panes[index]!;
    return (
      <EditorPanelToggle
        workbench={workbench}
        index={index}
        label={pane.label}
        icon={pane.icon}
        paneId={`${titleId}-pane-${index}`}
        collapse={collapse}
      />
    );
  }

  function paneHeading(index: number, label: ReactNode) {
    return (
      <div className="qt-metric-pane-heading">
        <h3>{label}</h3>
        {panelToggle(index, true)}
      </div>
    );
  }

  function patchWhere(id: string, update: (where: WhereTerm[]) => WhereTerm[]) {
    setDrafts((previous) =>
      previous.map((c) => {
        if (c.id !== id) return c;
        const { where: _where, ...rest } = c;
        const where = update(c.where ?? []);
        return where.length ? { ...rest, where } : rest;
      }),
    );
  }
  function patch(
    id: string,
    values: {
      [K in keyof AggregationClause]?: AggregationClause[K] | undefined;
    },
  ) {
    setDrafts((previous) =>
      previous.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...values } as AggregationClause;
        for (const key of Object.keys(next) as Array<keyof AggregationClause>)
          if (next[key] === undefined) delete next[key];
        return next;
      }),
    );
  }
  function displayPatch(values: Partial<MetricDisplay>) {
    if (selected) patch(selected.id, { display: { ...chosen, ...values } });
  }
  function move(id: string, position: number) {
    setDrafts((previous) => {
      const item = previous.find((c) => c.id === id);
      if (!item) return previous;
      const next = previous.filter((c) => c.id !== id);
      next.splice(Math.max(0, Math.min(position, next.length)), 0, item);
      return next;
    });
  }
  function remove(id: string) {
    const position = drafts.findIndex((c) => c.id === id),
      clause = drafts[position];
    if (!clause) return;
    focusDestination.current = true;
    setNavigation((previous) => previous + 1);
    setRemoved({ clause: clone(clause), position });
    setDrafts((previous) => previous.filter((c) => c.id !== id));
    if (active === id)
      setActive(drafts[position + 1]?.id ?? drafts[position - 1]?.id ?? "");
    setAnnouncement(
      `${titleOf(clause, fields)} removed. Undo is available in the footer.`,
    );
  }
  function duplicate(c: AggregationClause) {
    if (drafts.length >= MAX_AGGREGATIONS) return;
    const id = newId();
    setDrafts((previous) => [
      ...previous,
      { ...clone(c), id, label: `${titleOf(c, fields)} copy` },
    ]);
    navigate(view, id);
  }
  function regroup(groupBy: string[]) {
    if (!selected) return;
    const sort = selected.sort?.flatMap((s) => {
      if (!s.key.startsWith("group")) return [s];
      const name = selected.groupBy[Number(s.key.slice(5))];
      const index = name === undefined ? -1 : groupBy.indexOf(name);
      return index < 0
        ? []
        : [{ ...s, key: `group${index}` as `group${number}` }];
    });
    const dated = selected.dateGrouping?.field === groupBy[0];
    const share =
      groupBy.length >= (selected.share === "group0" ? 2 : 1)
        ? selected.share
        : undefined;
    patch(selected.id, {
      groupBy,
      ...(sort ? { sort } : {}),
      dateGrouping: dated ? selected.dateGrouping : undefined,
      window: dated ? selected.window : undefined,
      share,
      ...shareDisplay(selected.share, share),
    });
  }
  // Shares read best as percentages. The percent format a share adds leaves
  // with it, so plain sums are not shown as percentages; a format the author
  // chose is kept.
  function shareDisplay(
    previous: MetricShare | undefined,
    next: MetricShare | undefined,
  ): { display?: MetricDisplay } {
    if (next && !previous && !chosen.format)
      return { display: { ...chosen, format: SHARE_FORMAT } };
    if (!next && previous && sameFormat(chosen.format, SHARE_FORMAT)) {
      const { format: _format, ...display } = chosen;
      return { display };
    }
    return {};
  }
  function changeSize(key: keyof MetricLayout, raw: number) {
    if (!selected || !Number.isFinite(raw)) return;
    const layout = {
      ...(selected.layout ?? defaultLayout),
      [key]: Math.max(1, Math.min(75, Math.round(raw))),
    };
    layout.widthRem = Math.max(layout.widthRem, layout.minWidthRem);
    layout.heightRem = Math.max(layout.heightRem, layout.minHeightRem);
    patch(selected.id, { layout });
  }
  function changeDisplay(kind: MetricDisplay["kind"]) {
    if (!selected) return;
    // Distributions and scatters have no window or share, and hide their
    // settings, so leaving them set would strand an invalid metric.
    const single = !["box", "histogram", "quantiles", "scatter"].includes(kind);
    let display =
      (!single && shareDisplay(selected.share, undefined).display) || chosen;
    // They have no interval either; it leaves with its display setting.
    if (!single) display = withoutIntervalDisplay(display);
    const next: {
      [K in keyof AggregationClause]?: AggregationClause[K] | undefined;
    } = {
      display: { ...display, kind },
      ...(single
        ? {}
        : { window: undefined, share: undefined, interval: undefined }),
    };
    setFormatTarget(kind === "scatter" || kind === "histogram" || kind === "quantiles" ? "x" : "value");
    if (selected.sort)
      next.sort = selected.sort.filter(
        (s) =>
          (s.key !== "y" || kind === "scatter") &&
          (s.key !== "samples" || kind === "box" || kind === "histogram" || kind === "quantiles"),
      );
    if (kind === "scatter" && !selected.expressionY)
      next.expressionY = "COUNT()";
    if (kind === "scatter" && !selected.expression)
      next.expression = metricExpression(selected);
    // Distributions count rows for their minimum; a distinct or summed one
    // would be rejected, so it keeps its threshold over rows.
    const distributionKind = kind === "box" || kind === "histogram" || kind === "quantiles";
    if (distributionKind && metricMinCountMeasure(selected))
      next.minCount = metricMinCount(selected);
    if (distributionKind) {
      // Options of other kinds are retained as inactive alternatives, which
      // every engine ignores, so a box → quantiles → box round trip keeps them.
      next.distribution = {
        ...selected.distribution,
        ...(kind === "quantiles" && !selected.distribution?.probabilities
          ? { probabilities: defaultProbabilities }
          : {}),
        kind,
        input:
          selected.distribution?.input ??
          (selected.field
            ? fieldSource(selected.field)
            : measurable[0]
              ? fieldSource(measurable[0].name)
              : "NULL"),
      };
    }
    // Retain inactive expressions in the draft; only the active shape executes.
    patch(selected.id, next);
  }
  function changeExpression(source: string, secondary = false) {
    if (!selected) return;
    if (secondary) patch(selected.id, { expressionY: source });
    else if (rowInput)
      patch(selected.id, {
        distribution: {
          ...(selected.distribution ?? {
            kind: chosen.kind as "box" | "histogram" | "quantiles",
            input: source,
          }),
          input: source,
        },
      });
    else patch(selected.id, { expression: source });
  }
  function finishInsertion(textarea: HTMLTextAreaElement) {
    const pending = pendingInsertion.current;
    if (!pending || pending.id !== selected?.id) return;
    pendingInsertion.current = null;
    const from = pending.wrap ? 0 : textarea.value.indexOf("(") + 1;
    const to = pending.wrap
      ? textarea.value.length
      : textarea.value.lastIndexOf(")");
    textarea.setSelectionRange(from, Math.max(from, to));
    insertInto(textarea, pending.text, pending.wrap, false);
  }
  function insert(text: string, wrap = false) {
    if (!selected) return;
    const secondary = inputTarget === "secondary" && chosen.kind === "scatter";
    const textarea = secondary ? inputY.current : input.current;
    workbench.showPane(1);
    if (!textarea) {
      pendingInsertion.current = { id: selected.id, text, wrap };
      patch(selected.id, { expression: metricExpression(selected) });
      setAnnouncement("Formula mode enabled and reference inserted.");
      return;
    }
    if (!workbench.visiblePanes[1]) {
      requestAnimationFrame(() => insertInto(textarea, text, wrap, secondary));
    } else insertInto(textarea, text, wrap, secondary);
  }
  function insertInto(
    textarea: HTMLTextAreaElement,
    text: string,
    wrap: boolean,
    secondary: boolean,
  ) {
    const from = textarea.selectionStart,
      to = textarea.selectionEnd,
      selectedText = textarea.value.slice(from, to);
    const content = wrap ? `${text}(${selectedText})` : text;
    textarea.focus();
    textarea.setSelectionRange(from, to);
    const before = textarea.value;
    try {
      document.execCommand?.("insertText", false, content);
    } catch {
      /* plain textarea fallback */
    }
    if (textarea.value === before)
      textarea.setRangeText(content, from, to, "end");
    changeExpression(textarea.value, secondary);
    const position =
      from + (wrap ? text.length + selectedText.length + 1 : content.length);
    textarea.setSelectionRange(position, position);
  }
  function close() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  function apply() {
    if (diagnostics.size) return;
    if (contextChanged) {
      setError(
        "Metrics changed while this editor was open. Close this draft and reopen to use the latest configuration.",
      );
      return;
    }
    try {
      if (api.aggregations.replace)
        api.aggregations.replace(clone(drafts), initial.current);
      else api.setQuery((q) => ({ ...q, aggregations: clone(drafts) }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const resultById = new Map(preview?.metrics.map((m) => [m.id, m]) ?? []);
  const issues = new Map(diagnostics);
  for (const metric of preview?.metrics ?? [])
    if (metric.error) issues.set(metric.id, metric.error);
  const orderItems = drafts.map((c) => ({
    id: c.id,
    label: titleOf(c, fields),
  }));
  const selectedPosition = drafts.findIndex((c) => c.id === active);
  const selectedResult = selected ? resultById.get(selected.id) : undefined;
  const inspectedBucket =
    selectedResult?.buckets.find(
      (b) => JSON.stringify(b.keys) === inspectedKey,
    ) ?? selectedResult?.buckets[0];
  const referenceItems = (
    reference === "fields"
      ? fields.map((f) => ({
          name: f.name,
          label: f.label,
          detail: fieldSource(f.name),
          description: f.type,
          type: f.type,
          wrap: false,
        }))
      : [
          ...(concept !== "row" && !["box", "histogram", "quantiles"].includes(chosen.kind)
            ? aggregateFunctions
            : []),
          ...(concept !== "aggregate" ? FORMULA_FUNCTIONS : []),
        ].map((f) => ({
          name: f.name,
          label: f.name,
          detail: f.signature,
          description: f.description,
          type: aggregateFunctions.some((fn) => fn.name === f.name)
            ? "Aggregate"
            : "Row",
          wrap: true,
        }))
  ).filter((item) =>
    `${item.name} ${item.label} ${item.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const valueFormat = (formatTarget === "x"
    ? chosen.xFormat
    : formatTarget === "y"
      ? chosen.yFormat
      : chosen.format) ?? {
    kind: "number",
    decimals:
      selected &&
      !selected.expression &&
      ["count", "count_distinct"].includes(selected.op)
        ? 0
        : cardDecimals(selectedResult?.buckets ?? []),
  };
  const setFormat = (format: MetricValueFormat) =>
    displayPatch(
      formatTarget === "x"
        ? { xFormat: format }
        : formatTarget === "y"
          ? { yFormat: format }
          : { format },
    );
  const menu = (c: AggregationClause, index: number) => (
    <span className="qt-metric-actions">
      <MenuButton label={`Actions for ${titleOf(c, fields)}`} width={200} buttonProps={{ title: "Metric actions" }} trigger={<span aria-hidden>⋯</span>}>
        {view === "dashboard" && <MenuItem onSelect={() => navigate("editor", c.id)}>Edit metric</MenuItem>}
        <MenuItem disabled={drafts.length >= MAX_AGGREGATIONS} onSelect={() => duplicate(c)}>Duplicate</MenuItem>
        <MenuItem disabled={index === 0} onSelect={() => move(c.id, index - 1)}>Move up</MenuItem>
        <MenuItem disabled={index === drafts.length - 1} onSelect={() => move(c.id, index + 1)}>Move down</MenuItem>
        <MenuSeparator />
        <MenuItem tone="danger" onSelect={() => remove(c.id)}>Remove</MenuItem>
      </MenuButton>
    </span>
  );
  const sizeControls = selected && (
    <div className="qt-metric-size-controls">
      {(["widthRem", "heightRem", "minWidthRem", "minHeightRem"] as const).map(
        (key) => (
          <label key={key}>
            {
              {
                widthRem: "Width",
                heightRem: "Height",
                minWidthRem: "Min width",
                minHeightRem: "Min height",
              }[key]
            }{" "}
            (rem)
            <MetricNumberInput
              key={`${selected.id}-${key}`}
              aria-label={`${{ widthRem: "Width", heightRem: "Height", minWidthRem: "Min width", minHeightRem: "Min height" }[key]} in rem`}
              min={1}
              max={75}
              step={1}
              value={(selected.layout ?? defaultLayout)[key]}
              onCommit={(value) => changeSize(key, value)}
            />
          </label>
        ),
      )}
    </div>
  );
  const card = (c: AggregationClause) => (
    <MetricCard
      clause={c}
      result={
        diagnostics.has(c.id)
          ? { buckets: [], error: diagnostics.get(c.id)! }
          : resultById.get(c.id)
      }
      fields={fields}
      loading={previewLoading}
      theme={theme}
      locale={locale}
      onInspect={
        view === "editor" && c.id === active
          ? (bucket) => {
              setInspectedKey(JSON.stringify(bucket.keys));
              setInspectOpen(true);
            }
          : undefined
      }
    />
  );

  function separator(index: number) {
    return (
      <EditorPanelSeparator
        workbench={workbench}
        index={index}
        label={`Resize metric panes ${index + 1} and ${(workbench.nextPane(index) ?? index) + 1}`}
        controls={`${titleId}-pane-${index} ${titleId}-pane-${workbench.nextPane(index)}`}
      />
    );
  }

  return {
    api, fields, onClose, locale, inputY, groupable, separator, titleId,
    initial, drafts, setDrafts, active, setActive, view, setView, discard,
    setDiscard, error, announcement, setAnnouncement, preview, previewLoading,
    setRetry, canvas, setCanvas, returnMetric, removed, setRemoved,
    settingsState, geometryDrag, canvasElement, focusDestination,
    setNavigation, previewSize, setPreviewSize, formatTarget, setFormatTarget,
    reference, setReference, search, setSearch, concept, setConcept,
    inspectOpen, setInspectOpen, setInspectedKey, setInputTarget, input,
    previewContainer, workbench, selected, chosen, rowInput, dateField, dirty,
    contextChanged, measurable, fieldLabel, computationDiagnostics,
    diagnostics, intervalReasons, navigate, seeInDashboard, createMetric,
    canvasWidth, paneProps, panelToggle, paneHeading, patchWhere, patch,
    displayPatch, move, regroup, shareDisplay, changeDisplay, changeExpression,
    finishInsertion, insert, close, apply, issues, orderItems,
    selectedPosition, selectedResult, inspectedBucket, referenceItems,
    valueFormat, setFormat, menu, sizeControls, card,
  };
}

/** Everything the MetricsEditor render functions read. */
export type MetricsEditorState<Row> = ReturnType<
  typeof useMetricsEditorState<Row>
>;
