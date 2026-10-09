import { metricPresentationProblem } from "./metricPresentation";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import {
  MAX_AGGREGATIONS,
  aggOpsForField,
  compileFormula,
  compileMetric,
  isGroupable,
  isMeasurable,
  metricComputationKey,
  metricExpression,
  type AggregationBucket,
  type AggregationClause,
  type AggregationResult,
  type FieldDef,
  type MetricDisplay,
  type MetricLayout,
  type MetricValueFormat,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { ModalSurface } from "./AdaptiveOverlay";
import { ReorderList } from "./ReorderList";
import { MetricCard, cardDecimals } from "./MetricsPanel";
import { formatMetricOutput, validateMetricFormat } from "./metricFormat";
import type { MetricTheme } from "./metricColors";
import { useMetricWorkbench } from "./useMetricWorkbench";
import { useMetricResize } from "./useMetricResize";
import { Icon, type IconName } from "./Icon";
import { FORMULA_FUNCTIONS } from "@pythia-software/query-table-core";

const FormulaEditor = lazy(() => import("./FormulaEditor"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fieldSource = (name: string) => `[${name.replace(/\]/g, "]]")}]`;
const defaultLayout: MetricLayout = {
  widthRem: 20,
  heightRem: 12,
  minWidthRem: 14,
  minHeightRem: 8,
};
const kinds: Array<[MetricDisplay["kind"], string]> = [
  ["auto", "Automatic"],
  ["value", "Value"],
  ["table", "Table"],
  ["list", "List"],
  ["bar-horizontal", "Horizontal bars"],
  ["bar-vertical", "Vertical bars"],
  ["line", "Line chart"],
  ["pie", "Pie chart"],
  ["donut", "Ring chart"],
  ["scatter", "Scatterplot"],
  ["box", "Box & whisker"],
  ["histogram", "Histogram"],
];
const panes: Array<{ label: string; icon: IconName }> = [
  { label: "Metric list", icon: "panelList" },
  { label: "Definition", icon: "panelDefinition" },
  { label: "Fields & functions", icon: "panelReference" },
  { label: "Live preview", icon: "panelPreview" },
];
const aggregateFunctions = [
  {
    name: "SUM",
    signature: "SUM(row expression)",
    description: "Total numeric values per group; ignores NULL.",
  },
  {
    name: "AVG",
    signature: "AVG(row expression)",
    description: "Average numeric values per group; ignores NULL.",
  },
  {
    name: "COUNT",
    signature: "COUNT(expression?)",
    description: "Count rows, or non-NULL values per group.",
  },
  {
    name: "COUNT_DISTINCT",
    signature: "COUNT_DISTINCT(row expression)",
    description: "Count distinct non-NULL values per group.",
  },
  {
    name: "MIN",
    signature: "MIN(row expression)",
    description: "Minimum non-NULL value per group.",
  },
  {
    name: "MAX",
    signature: "MAX(row expression)",
    description: "Maximum non-NULL value per group.",
  },
];
const titleOf = (clause: AggregationClause, fields: FieldDef[]) =>
  clause.label ||
  `${clause.op.toUpperCase()} ${fields.find((f) => f.name === clause.field)?.label ?? clause.field ?? "rows"}`;

export interface MetricsEditorProps<Row> {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  onClose: () => void;
  initialMetricId?: string;
  initialView?: "editor" | "dashboard";
  theme?: MetricTheme;
  locale?: string;
}

/** Transactional query-local authoring; previews never mutate the table query. */
export function MetricsEditor<Row>({
  api,
  fields,
  onClose,
  initialMetricId,
  initialView = "editor",
  theme,
  locale,
}: MetricsEditorProps<Row>): ReactNode {
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
  const dirty = JSON.stringify(drafts) !== initialKey.current;
  const contextChanged =
    JSON.stringify(api.aggregations.clauses) !== initialKey.current;
  const measurable = fields.filter(isMeasurable),
    groupable = fields.filter(isGroupable);
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
          ["box", "histogram"].includes(c.display?.kind ?? c.distribution.kind)
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
    const shown = workbench.visiblePanes[index];
    return (
      <button
        type="button"
        className={`qt-btn qt-metric-icon-button${collapse ? " qt-metric-pane-collapse" : ""}`}
        aria-label={
          collapse
            ? `Hide ${pane.label.toLowerCase()} panel`
            : `${pane.label} panel`
        }
        aria-controls={`${titleId}-pane-${index}`}
        aria-pressed={collapse ? undefined : shown}
        disabled={shown && workbench.visibleIndices.length === 1}
        title={`${shown ? "Hide" : "Show"} ${pane.label.toLowerCase()} panel`}
        onClick={() => workbench.togglePane(index)}
      >
        <Icon name={collapse ? "close" : pane.icon} />
      </button>
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
    patch(selected.id, { groupBy, ...(sort ? { sort } : {}) });
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
    const next: Partial<AggregationClause> = { display: { ...chosen, kind } };
    setFormatTarget(kind === "scatter" || kind === "histogram" ? "x" : "value");
    if (selected.sort)
      next.sort = selected.sort.filter(
        (s) =>
          (s.key !== "y" || kind === "scatter") &&
          (s.key !== "samples" || kind === "box" || kind === "histogram"),
      );
    if (kind === "scatter" && !selected.expressionY)
      next.expressionY = "COUNT()";
    if (kind === "scatter" && !selected.expression)
      next.expression = metricExpression(selected);
    if (kind === "box" || kind === "histogram")
      next.distribution = {
        ...selected.distribution,
        kind,
        input:
          selected.distribution?.input ??
          (selected.field
            ? fieldSource(selected.field)
            : measurable[0]
              ? fieldSource(measurable[0].name)
              : "NULL"),
      };
    // Retain inactive expressions in the draft; only the active shape executes.
    patch(selected.id, next);
  }
  function changeExpression(source: string, secondary = false) {
    if (!selected) return;
    if (secondary) patch(selected.id, { expressionY: source });
    else if (["box", "histogram"].includes(chosen.kind))
      patch(selected.id, {
        distribution: {
          ...(selected.distribution ?? {
            kind: chosen.kind as "box" | "histogram",
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
          ...(concept !== "row" && !["box", "histogram"].includes(chosen.kind)
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
    <details
      className="qt-metric-actions"
      onKeyDown={(e) => {
        if (e.key === "Escape" && e.currentTarget.open) {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.open = false;
          e.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={`Actions for ${titleOf(c, fields)}`}>⋯</summary>
      <div
        onClick={(e) => {
          const details = e.currentTarget.closest("details");
          if (details) {
            details.open = false;
            details.querySelector("summary")?.focus();
          }
        }}
      >
        {view === "dashboard" && (
          <button
            type="button"
            onClick={() => {
              navigate("editor", c.id);
            }}
          >
            Edit metric
          </button>
        )}
        <button
          type="button"
          disabled={drafts.length >= MAX_AGGREGATIONS}
          onClick={() => duplicate(c)}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => move(c.id, index - 1)}
        >
          Move up
        </button>
        <button
          type="button"
          disabled={index === drafts.length - 1}
          onClick={() => move(c.id, index + 1)}
        >
          Move down
        </button>
        <button
          type="button"
          className="qt-metric-remove"
          onClick={() => remove(c.id)}
        >
          Remove
        </button>
      </div>
    </details>
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

  return (
    <ModalSurface
      title="Edit metrics"
      className="qt-modal qt-metrics-editor"
      chrome={false}
      onClose={close}
    >
      <header ref={workbench.header} className="qt-metrics-editor-header">
        <h2 id={titleId}>Edit metrics</h2>
        <label>
          <span className="qt-sr-only">Workbench view</span>
          <select
            aria-label="Workbench view"
            value={view}
            onChange={(e) => {
              geometryDrag.stop();
              setView(e.target.value as typeof view);
            }}
          >
            <option value="editor">Metric editor</option>
            <option value="dashboard">Dashboard layout</option>
          </select>
        </label>
        <button
          type="button"
          className="qt-btn qt-metric-reset-layout"
          title="Restore dialog size and show all panels"
          onClick={workbench.reset}
        >
          Reset layout
        </button>
        <button
          type="button"
          className="qt-btn qt-metric-close"
          aria-label="Close metric editor"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="qt-metrics-editor-context">
        <span>
          Shown: <b>{api.rows.length.toLocaleString(locale)} rows</b>
        </span>
        <span>
          Matching:{" "}
          <b>
            {api.total === null ? "unknown" : api.total.toLocaleString(locale)}{" "}
            rows
          </b>
        </span>
        <span>
          {api.query.where.length
            ? `${api.query.where.length} filter terms`
            : "No filters"}
        </span>
      </div>
      {view === "editor" && (
        <div className="qt-metric-workbench-tools">
          <div className="qt-metric-selection-tools">
            <select
              aria-label="Editing metric"
              value={active}
              onChange={(e) => setActive(e.target.value)}
              disabled={!drafts.length}
            >
              {!drafts.length && <option value="">No metrics yet</option>}
              {orderItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="qt-btn qt-metric-icon-button"
              aria-label="Previous metric"
              title="Previous metric"
              disabled={selectedPosition <= 0}
              onClick={() => setActive(drafts[selectedPosition - 1]!.id)}
            >
              <Icon name="arrowUp" />
            </button>
            <button
              type="button"
              className="qt-btn qt-metric-icon-button"
              aria-label="Next metric"
              title="Next metric"
              disabled={
                selectedPosition < 0 || selectedPosition >= drafts.length - 1
              }
              onClick={() => setActive(drafts[selectedPosition + 1]!.id)}
            >
              <Icon name="arrowDown" />
            </button>
          </div>
          <button
            type="button"
            className="qt-btn qt-metric-context-link"
            disabled={!selected}
            onClick={seeInDashboard}
          >
            <Icon name="dashboard" />
            See in dashboard
            <Icon name="arrowRight" size={14} />
          </button>
          <div
            className="qt-metric-panel-tools"
            role="group"
            aria-label="Visible editor panels"
          >
            <span>Panels</span>
            {panes.map((pane, i) => (
              <span key={pane.label}>{panelToggle(i)}</span>
            ))}
          </div>
        </div>
      )}
      {view === "dashboard" ? (
        <section className="qt-metric-layout-editor">
          <div className="qt-metric-canvas-controls">
            <div className="qt-metric-canvas-heading">
              <strong>Dashboard layout</strong>
              <p className="qt-metric-help">
                Select a card to adjust it. Drag handles to reorder, corners to
                resize.
              </p>
            </div>
            {returnMetric && drafts.some((c) => c.id === returnMetric) && (
              <button
                type="button"
                className="qt-btn qt-metric-return"
                title={`Return to ${titleOf(
                  drafts.find((c) => c.id === returnMetric)!,
                  fields,
                )}`}
                onClick={() => navigate("editor", returnMetric)}
              >
                <Icon name="arrowLeft" />
                Back to metric
              </button>
            )}
            <button
              type="button"
              className="qt-btn"
              disabled={drafts.length >= MAX_AGGREGATIONS}
              onClick={createMetric}
            >
              <Icon name="add" />
              Create metric
            </button>
            <div
              className="qt-metric-canvas-presets"
              role="group"
              aria-label="Viewport presets"
            >
              <label>
                Canvas width (px)
                <MetricNumberInput
                  aria-label="Canvas width"
                  min={320}
                  max={2400}
                  step={10}
                  value={canvas}
                  onCommit={canvasWidth}
                />
              </label>
              <span>or preset</span>
              {([360, 768, 1200] as const).map((width) => (
                <button
                  type="button"
                  className="qt-btn"
                  key={width}
                  aria-pressed={canvas === width}
                  onClick={() => setCanvas(width)}
                >
                  {width === 360
                    ? "Phone"
                    : width === 768
                      ? "Tablet"
                      : "Desktop"}{" "}
                  · {width}
                </button>
              ))}
            </div>
          </div>
          <div className="qt-metric-layout-controls">
            <label className="qt-metric-layout-picker">
              Selected metric
              <select
                aria-label="Selected metric"
                value={active}
                onChange={(e) => setActive(e.target.value)}
              >
                {orderItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <label className="qt-metric-layout-name">
                Name
                <input
                  aria-label="Layout metric name"
                  maxLength={1000}
                  value={selected.label ?? titleOf(selected, fields)}
                  onChange={(e) =>
                    patch(selected.id, { label: e.target.value })
                  }
                />
              </label>
            )}
            {sizeControls}
            <button
              type="button"
              className="qt-btn"
              disabled={!selected}
              onClick={() => navigate("editor")}
            >
              Edit metric
            </button>
          </div>
          <div className="qt-metric-canvas-scroll">
            <div
              className="qt-metric-canvas-frame"
              style={{ width: canvas + 18 }}
            >
              <div
                ref={canvasElement}
                className="qt-metric-layout-canvas"
                style={{ width: canvas }}
              >
                <ReorderList
                  items={orderItems}
                  layout="wrap"
                  showHint={false}
                  className="qt-metric-layout-items"
                  onMove={move}
                  itemClassName={(item) =>
                    item.id === active ? "qt-metric-layout-selected" : ""
                  }
                  itemStyle={(item) => {
                    const c = drafts.find((d) => d.id === item.id)!,
                      layout = c.layout ?? defaultLayout;
                    return {
                      flexBasis: `${layout.widthRem}rem`,
                      minWidth: `${layout.minWidthRem}rem`,
                      minHeight: `${layout.minHeightRem}rem`,
                      height: `${Math.max(layout.heightRem, layout.minHeightRem)}rem`,
                      flexGrow: 1,
                    };
                  }}
                  renderItem={(item, index) => {
                    const c = drafts.find((d) => d.id === item.id)!;
                    return (
                      <div
                        className="qt-metric-layout-card"
                        data-metric-id={item.id}
                        tabIndex={0}
                        aria-label={`Select ${item.label}`}
                        aria-current={item.id === active}
                        title={`${item.label} · Double-click to edit`}
                        onFocus={() => setActive(item.id)}
                        onDoubleClick={(e) => {
                          if (
                            !(e.target as Element).closest(
                              "button, input, select, textarea, summary, a, [role=button]",
                            )
                          )
                            navigate("editor", item.id);
                        }}
                        onClick={(e) => {
                          if (
                            !(e.target as Element).closest(
                              "button, input, select, textarea, summary, a",
                            )
                          )
                            setActive(item.id);
                        }}
                        onKeyDown={(e) => {
                          if (
                            e.currentTarget === e.target &&
                            (e.key === "Enter" || e.key === " ")
                          ) {
                            e.preventDefault();
                            setActive(item.id);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="qt-btn qt-metric-card-edit qt-metric-icon-button"
                          aria-label={`Edit ${item.label}`}
                          title="Edit metric"
                          onClick={() => navigate("editor", item.id)}
                        >
                          <Icon name="pencil" size={14} />
                        </button>
                        {menu(c, index)}
                        {card(c)}
                        <button
                          type="button"
                          className="qt-metric-card-resize"
                          aria-label={`Resize ${item.label}`}
                          title="Drag to resize card. Arrow keys adjust width and height; Shift for larger steps."
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            setActive(c.id);
                            const original = c.layout,
                              base = { ...(original ?? defaultLayout) };
                            const rem =
                              parseFloat(
                                getComputedStyle(document.documentElement)
                                  .fontSize,
                              ) || 16;
                            geometryDrag.start(
                              e,
                              (dx, dy) => {
                                const widthRem = Math.max(
                                  base.minWidthRem,
                                  Math.min(
                                    75,
                                    Math.round(base.widthRem + dx / rem),
                                  ),
                                );
                                const heightRem = Math.max(
                                  base.minHeightRem,
                                  Math.min(
                                    75,
                                    Math.round(base.heightRem + dy / rem),
                                  ),
                                );
                                patch(c.id, {
                                  layout:
                                    widthRem === base.widthRem &&
                                    heightRem === base.heightRem
                                      ? original
                                      : { ...base, widthRem, heightRem },
                                });
                              },
                              () => patch(c.id, { layout: original }),
                            );
                          }}
                          onKeyDown={(e) => {
                            if (
                              ![
                                "ArrowLeft",
                                "ArrowRight",
                                "ArrowUp",
                                "ArrowDown",
                                "Home",
                              ].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            e.stopPropagation();
                            const base = c.layout ?? defaultLayout,
                              step = e.shiftKey ? 4 : 1;
                            const layout = {
                              ...base,
                              widthRem: Math.max(
                                base.minWidthRem,
                                Math.min(
                                  75,
                                  e.key === "Home"
                                    ? defaultLayout.widthRem
                                    : base.widthRem +
                                        (e.key === "ArrowRight"
                                          ? step
                                          : e.key === "ArrowLeft"
                                            ? -step
                                            : 0),
                                ),
                              ),
                              heightRem: Math.max(
                                base.minHeightRem,
                                Math.min(
                                  75,
                                  e.key === "Home"
                                    ? defaultLayout.heightRem
                                    : base.heightRem +
                                        (e.key === "ArrowDown"
                                          ? step
                                          : e.key === "ArrowUp"
                                            ? -step
                                            : 0),
                                ),
                              ),
                            };
                            if (
                              layout.widthRem !== base.widthRem ||
                              layout.heightRem !== base.heightRem
                            )
                              patch(c.id, { layout });
                          }}
                        >
                          <Icon name="resize" size={14} />
                        </button>
                      </div>
                    );
                  }}
                />
                {!drafts.length && (
                  <div className="qt-metric-authoring-empty">
                    <Icon name="dashboard" size={28} />
                    <strong>Your dashboard is empty</strong>
                    <p>Create a metric to start arranging your dashboard.</p>
                    <button
                      type="button"
                      className="qt-btn"
                      onClick={createMetric}
                    >
                      <Icon name="add" />
                      Create your first metric
                    </button>
                  </div>
                )}
              </div>
              <div
                className="qt-metric-canvas-resize"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize dashboard canvas"
                aria-valuemin={320}
                aria-valuemax={2400}
                aria-valuenow={canvas}
                aria-valuetext={`${canvas} pixels`}
                title="Drag to resize canvas. Left / Right adjust width; Home or double-click resets."
                onPointerDown={(e) => {
                  const initial = canvas;
                  geometryDrag.start(
                    e,
                    (dx) => canvasWidth(initial + dx),
                    () => setCanvas(initial),
                  );
                }}
                onDoubleClick={() => setCanvas(1120)}
                onKeyDown={(e) => {
                  if (e.key === "Home") {
                    e.preventDefault();
                    setCanvas(1120);
                  }
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    canvasWidth(
                      canvas +
                        (e.key === "ArrowLeft" ? -1 : 1) *
                          (e.shiftKey ? 50 : 10),
                    );
                  }
                }}
              >
                <Icon name="grip" size={14} />
              </div>
            </div>
          </div>
          <p className="qt-metric-canvas-note qt-metric-help">
            {canvas} px canvas · Drag the right edge to test wrapping. Card
            widths are preferred sizes; cards expand to fill each row.
          </p>
        </section>
      ) : (
        <div
          ref={workbench.root}
          className="qt-metric-workspace"
          style={{
            gridTemplateColumns: workbench.visibleIndices
              .map((i) => `${workbench.widths[i]}px`)
              .join(" 6px "),
          }}
        >
          <aside
            className="qt-metric-library"
            {...paneProps(0)}
            aria-label="Metrics in this query"
          >
            {paneHeading(
              0,
              <>
                In this query <span>· {drafts.length}</span>
              </>,
            )}
            <ReorderList
              items={orderItems}
              onMove={move}
              showHint={false}
              itemClassName={(item) =>
                item.id === active ? "qt-metric-library-selected" : ""
              }
              renderItem={(item, index) => {
                const c = drafts.find((d) => d.id === item.id)!;
                return (
                  <>
                    <button
                      type="button"
                      className="qt-metric-library-chip"
                      aria-current={item.id === active}
                      onClick={() => setActive(item.id)}
                    >
                      <strong>
                        {item.label}
                        {issues.has(c.id) && (
                          <span
                            className="qt-metric-needs-attention"
                            aria-label="Needs attention"
                            title={issues.get(c.id)}
                          >
                            <Icon name="alert" size={12} />
                          </span>
                        )}
                        {JSON.stringify(c) !==
                          JSON.stringify(
                            initial.current.find((m) => m.id === c.id),
                          ) && (
                          <i
                            className="qt-metric-dirty-dot"
                            aria-label="Modified"
                          />
                        )}
                      </strong>
                      <span>
                        {c.groupBy
                          .map(
                            (g) => fields.find((f) => f.name === g)?.label ?? g,
                          )
                          .join(" × ") || "One value"}{" "}
                        ·{" "}
                        {c.scope === "shownRows"
                          ? "Shown rows"
                          : "All matching"}
                      </span>
                    </button>
                    {menu(c, index)}
                  </>
                );
              }}
            />
            <button
              type="button"
              className="qt-btn qt-metric-create"
              disabled={drafts.length >= MAX_AGGREGATIONS}
              onClick={createMetric}
            >
              + Create metric
            </button>
          </aside>
          {separator(0)}
          <section className="qt-metric-definition" {...paneProps(1)}>
            {paneHeading(1, "Metric definition")}
            {selected ? (
              <>
                <label>
                  Metric name
                  <input
                    aria-label="Metric name"
                    maxLength={1000}
                    value={selected.label ?? titleOf(selected, fields)}
                    onChange={(e) =>
                      patch(selected.id, { label: e.target.value })
                    }
                  />
                </label>
                <div className="qt-metric-expression-heading">
                  <strong>
                    {["box", "histogram"].includes(chosen.kind)
                      ? "Values to summarize"
                      : chosen.kind === "scatter"
                        ? "X expression"
                        : "Expression"}
                  </strong>
                  {!["box", "histogram", "scatter"].includes(chosen.kind) && (
                    <div
                      className="qt-metric-mode"
                      role="group"
                      aria-label="Expression mode"
                    >
                      <button
                        type="button"
                        aria-pressed={selected.expression === undefined}
                        disabled={
                          selected.expression !== undefined &&
                          !simpleAggregate(selected, fields)
                        }
                        title={
                          selected.expression !== undefined &&
                          !simpleAggregate(selected, fields)
                            ? "This formula cannot be represented in Basic"
                            : undefined
                        }
                        onClick={() => {
                          const basic = simpleAggregate(selected, fields);
                          if (basic)
                            patch(selected.id, {
                              op: basic.op,
                              field: basic.field,
                              expression: undefined,
                            });
                        }}
                      >
                        Basic
                      </button>
                      <button
                        type="button"
                        aria-pressed={selected.expression !== undefined}
                        onClick={() =>
                          patch(selected.id, {
                            expression: metricExpression(selected),
                          })
                        }
                      >
                        Formula
                      </button>
                    </div>
                  )}
                </div>
                {selected.expression === undefined &&
                !["box", "histogram", "scatter"].includes(chosen.kind) ? (
                  <div className="qt-metric-basic">
                    <select
                      aria-label="Aggregation function"
                      value={selected.op}
                      onChange={(e) =>
                        patch(selected.id, {
                          op: e.target.value as AggregationClause["op"],
                        })
                      }
                    >
                      {(selected.field &&
                      fields.find((f) => f.name === selected.field)
                        ? aggOpsForField(
                            fields.find((f) => f.name === selected.field)!,
                          )
                        : ["count"]
                      ).map((op) => (
                        <option key={op} value={op}>
                          {op.toUpperCase()}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Measure field"
                      value={selected.field ?? ""}
                      onChange={(e) => {
                        const field = e.target.value;
                        const definition = fields.find((f) => f.name === field);
                        patch(selected.id, {
                          field: field || undefined,
                          op:
                            definition &&
                            aggOpsForField(definition).includes(selected.op)
                              ? selected.op
                              : "count",
                        });
                      }}
                    >
                      <option value="">All rows</option>
                      {measurable.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <Suspense fallback={<p>Loading expression editor…</p>}>
                    <FormulaEditor
                      key={`${selected.id}-x`}
                      value={
                        ["box", "histogram"].includes(chosen.kind)
                          ? (selected.distribution?.input ?? "NULL")
                          : metricExpression(selected)
                      }
                      onChange={(source) => changeExpression(source)}
                      fields={fields}
                      compile={(source) =>
                        api.aggregations.compile
                          ? api.aggregations.compile(
                              ["box", "histogram"].includes(chosen.kind)
                                ? {
                                    ...selected,
                                    distribution: {
                                      ...selected.distribution!,
                                      input: source,
                                    },
                                  }
                                : { ...selected, expression: source },
                            )
                          : ["box", "histogram"].includes(chosen.kind)
                            ? compileFormula(source, fields)
                            : compileMetric(source, fields)
                      }
                      rows={3}
                      suggestions={false}
                      showLibrary={false}
                      ariaLabel="Metric expression"
                      inputRef={input}
                      onReady={finishInsertion}
                      onFocus={() => setInputTarget("primary")}
                    />
                  </Suspense>
                )}
                {chosen.kind === "scatter" && (
                  <>
                    <strong>Y expression</strong>
                    <Suspense fallback={<p>Loading expression editor…</p>}>
                      <FormulaEditor
                        key={`${selected.id}-y`}
                        value={selected.expressionY ?? "COUNT()"}
                        onChange={(source) => changeExpression(source, true)}
                        fields={fields}
                        compile={(source) =>
                          api.aggregations.compile
                            ? api.aggregations.compile({
                                ...selected,
                                expressionY: source,
                              })
                            : compileMetric(source, fields)
                        }
                        rows={3}
                        suggestions={false}
                        showLibrary={false}
                        ariaLabel="Y metric expression"
                        inputRef={inputY}
                        onFocus={() => setInputTarget("secondary")}
                      />
                    </Suspense>
                  </>
                )}
                {diagnostics.get(selected.id) &&
                  (!computationDiagnostics.has(selected.id) ||
                    (selected.expression === undefined &&
                      !["box", "histogram", "scatter"].includes(
                        chosen.kind,
                      ))) && (
                    <p className="qt-metric-editor-error" role="status">
                      {diagnostics.get(selected.id)}
                    </p>
                  )}
                {!diagnostics.has(selected.id) && (
                  <p className="qt-metric-validation">✓ Valid expression</p>
                )}
                <Settings
                  title="Data scope"
                  {...settingsState("Data scope")}
                  summary={
                    selected.scope === "shownRows"
                      ? "Shown rows"
                      : "All matching rows"
                  }
                >
                  <div
                    className="qt-metric-scope"
                    role="group"
                    aria-label="Calculate over"
                  >
                    {(["allMatching", "shownRows"] as const).map((scope) => (
                      <button
                        type="button"
                        key={scope}
                        aria-pressed={
                          (selected.scope ?? "allMatching") === scope
                        }
                        onClick={() => patch(selected.id, { scope })}
                      >
                        {scope === "allMatching"
                          ? "All matching rows"
                          : "Shown rows"}
                      </button>
                    ))}
                  </div>
                  <p className="qt-metric-help">
                    {selected.scope === "shownRows"
                      ? "Uses only rows on the current page, after sorting and paging."
                      : "Uses every matching row; ignores the table’s limit and offset."}
                  </p>
                </Settings>
                <Settings
                  title="Grouping"
                  {...settingsState("Grouping")}
                  summary={
                    selected.groupBy.length
                      ? selected.groupBy
                          .map(
                            (g) => fields.find((f) => f.name === g)?.label ?? g,
                          )
                          .join(" × ")
                      : "One value"
                  }
                >
                  {selected.groupBy.map((group, index) => (
                    <div
                      className="qt-metric-group-row"
                      key={`${group}-${index}`}
                    >
                      <select
                        aria-label={`Grouping ${index + 1}`}
                        value={group}
                        onChange={(e) => {
                          const groupBy = [...selected.groupBy];
                          groupBy[index] = e.target.value;
                          patch(selected.id, { groupBy });
                        }}
                      >
                        {groupable.map((f) => (
                          <option
                            key={f.name}
                            value={f.name}
                            disabled={
                              f.name !== group &&
                              selected.groupBy.includes(f.name)
                            }
                          >
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove grouping ${index + 1}`}
                        onClick={() =>
                          regroup(
                            selected.groupBy.filter((_, i) => i !== index),
                          )
                        }
                      >
                        ×
                      </button>
                      {index > 0 && (
                        <button
                          type="button"
                          aria-label={`Move grouping ${index + 1} up`}
                          onClick={() => {
                            const groups = [...selected.groupBy];
                            [groups[index], groups[index - 1]] = [
                              groups[index - 1]!,
                              groups[index]!,
                            ];
                            regroup(groups);
                          }}
                        >
                          ↑
                        </button>
                      )}
                    </div>
                  ))}
                  <select
                    aria-label="Add grouping"
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        patch(selected.id, {
                          groupBy: [...selected.groupBy, e.target.value],
                        });
                    }}
                  >
                    <option value="">+ Add grouping</option>
                    {groupable
                      .filter((f) => !selected.groupBy.includes(f.name))
                      .map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label}
                        </option>
                      ))}
                  </select>
                </Settings>
                <Settings
                  title="Ordering & limits"
                  {...settingsState("Ordering & limits")}
                  summary={
                    selected.sort?.length
                      ? `${selected.sort.length} sort ${selected.sort.length === 1 ? "rule" : "rules"}${selected.groupLimit ? ` · first ${selected.groupLimit}` : ""}`
                      : `Default ordering${selected.groupLimit ? ` · first ${selected.groupLimit}` : ""}`
                  }
                >
                  {(selected.sort ?? []).map((sort, index) => (
                    <div className="qt-metric-sort-row" key={index}>
                      <select
                        aria-label={`Sort result ${index + 1}`}
                        value={sort.key}
                        onChange={(e) =>
                          patch(selected.id, {
                            sort: selected.sort!.map((s, i) =>
                              i === index
                                ? { ...s, key: e.target.value as typeof s.key }
                                : s,
                            ),
                          })
                        }
                      >
                        <option value="value">
                          {chosen.kind === "box"
                            ? "Median"
                            : chosen.kind === "scatter"
                              ? "X value"
                              : "Value"}
                        </option>
                        {chosen.kind === "scatter" && (
                          <option value="y">Y value</option>
                        )}
                        <option value="count">Rows</option>
                        {["box", "histogram"].includes(chosen.kind) && (
                          <option value="samples">Numeric samples</option>
                        )}
                        {selected.groupBy.map((g, i) => (
                          <option key={g} value={`group${i}`}>
                            {fields.find((f) => f.name === g)?.label ?? g}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Sort direction ${index + 1}`}
                        value={sort.dir}
                        onChange={(e) =>
                          patch(selected.id, {
                            sort: selected.sort!.map((s, i) =>
                              i === index
                                ? {
                                    ...s,
                                    dir: e.target.value as "asc" | "desc",
                                  }
                                : s,
                            ),
                          })
                        }
                      >
                        <option value="asc">Ascending</option>
                        <option value="desc">Descending</option>
                      </select>
                      <select
                        aria-label={`Null placement ${index + 1}`}
                        value={sort.nulls ?? "last"}
                        onChange={(e) =>
                          patch(selected.id, {
                            sort: selected.sort!.map((s, i) =>
                              i === index
                                ? {
                                    ...s,
                                    nulls: e.target.value as "first" | "last",
                                  }
                                : s,
                            ),
                          })
                        }
                      >
                        <option value="last">NULL last</option>
                        <option value="first">NULL first</option>
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove sort ${index + 1}`}
                        onClick={() =>
                          patch(selected.id, {
                            sort: selected.sort!.filter((_, i) => i !== index),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="qt-btn"
                    disabled={(selected.sort?.length ?? 0) >= 20}
                    onClick={() =>
                      patch(selected.id, {
                        sort: [
                          ...(selected.sort ?? []),
                          { key: "value", dir: "desc", nulls: "last" },
                        ],
                      })
                    }
                  >
                    + Add sort
                  </button>
                  <label>
                    Show first groups
                    <input
                      aria-label="Metric group limit"
                      type="number"
                      min={1}
                      max={10000}
                      placeholder="All groups"
                      value={selected.groupLimit ?? ""}
                      onChange={(e) => {
                        const n = e.currentTarget.valueAsNumber;
                        if (!e.currentTarget.value)
                          patch(selected.id, { groupLimit: undefined });
                        else if (Number.isInteger(n) && n >= 1 && n <= 10000)
                          patch(selected.id, { groupLimit: n });
                      }}
                    />
                  </label>
                </Settings>
                <Settings
                  title="Display"
                  {...settingsState("Display")}
                  summary={`${kinds.find(([kind]) => kind === chosen.kind)?.[1] ?? chosen.kind}${chosen.format ? ` · ${chosen.format.kind}` : ""}`}
                >
                  {chosen.kind === "scatter" && (
                    <label>
                      Format measure
                      <select
                        aria-label="Format measure"
                        value={formatTarget}
                        onChange={(e) =>
                          setFormatTarget(e.target.value as "x" | "y")
                        }
                      >
                        <option value="x">X output</option>
                        <option value="y">Y output</option>
                      </select>
                    </label>
                  )}
                  <MetricFormatControls
                    displayControl={
                      <label>
                        Display
                        <select
                          aria-label="Metric display"
                          value={chosen.kind}
                          onChange={(e) =>
                            changeDisplay(
                              e.target.value as MetricDisplay["kind"],
                            )
                          }
                        >
                          {kinds.map(([kind, label]) => (
                            <option key={kind} value={kind}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    }
                    format={valueFormat}
                    onChange={setFormat}
                    sample={
                      chosen.kind === "histogram" &&
                      selectedResult?.buckets[0]?.distribution?.kind ===
                        "histogram"
                        ? selectedResult.buckets[0].distribution.edges[0]
                        : formatTarget === "y"
                          ? selectedResult?.buckets[0]?.y
                          : selectedResult?.buckets[0]?.value
                    }
                    locale={locale}
                  />
                  {[
                    "bar-horizontal",
                    "bar-vertical",
                    "line",
                    "scatter",
                    "box",
                    "histogram",
                    "list",
                  ].includes(chosen.kind) && (
                    <details className="qt-metric-settings">
                      <summary>Scale & bounds</summary>
                      {(chosen.kind === "scatter" ||
                      chosen.kind === "histogram" ||
                      chosen.kind === "line"
                        ? (["xScale", "yScale"] as const)
                        : ([
                            chosen.kind === "box" ||
                            chosen.kind === "bar-horizontal" ||
                            chosen.kind === "list"
                              ? "xScale"
                              : "yScale",
                          ] as const)
                      ).map((key) => (
                        <fieldset key={key} className="qt-metric-axis-settings">
                          <legend>
                            {key === "xScale"
                              ? "X / horizontal axis"
                              : "Y / vertical axis"}
                          </legend>
                          <label>
                            Scale
                            <select
                              aria-label={`${key === "xScale" ? "X" : "Y"} axis scale`}
                              value={chosen[key]?.mode ?? "linear"}
                              onChange={(e) =>
                                displayPatch({
                                  [key]: {
                                    ...chosen[key],
                                    mode: e.target.value,
                                  },
                                })
                              }
                            >
                              <option value="linear">Linear</option>
                              <option value="log">Logarithmic</option>
                            </select>
                          </label>
                          {(["min", "max"] as const).map((bound) => (
                            <label key={bound}>
                              {bound === "min" ? "Minimum" : "Maximum"}
                              <input
                                type="number"
                                step="any"
                                placeholder="Automatic"
                                aria-label={`${key === "xScale" ? "X" : "Y"} axis ${bound}`}
                                value={chosen[key]?.[bound] ?? ""}
                                onChange={(e) => {
                                  if (e.target.validity.badInput) return;
                                  const next = { ...chosen[key] };
                                  if (e.target.value === "") delete next[bound];
                                  else next[bound] = Number(e.target.value);
                                  displayPatch({ [key]: next });
                                }}
                              />
                            </label>
                          ))}
                        </fieldset>
                      ))}
                      <p className="qt-muted">
                        Bounds use raw result units. Logarithmic axes omit zero
                        and negative values. Pie and ring charts use
                        proportional areas.
                      </p>
                    </details>
                  )}
                  {["pie", "donut", "scatter", "histogram"].includes(
                    chosen.kind,
                  ) && (
                    <label>
                      Legend placement
                      <select
                        aria-label="Legend placement"
                        value={chosen.legendPosition ?? "right"}
                        onChange={(e) =>
                          displayPatch({
                            legendPosition: e.target.value as NonNullable<
                              MetricDisplay["legendPosition"]
                            >,
                          })
                        }
                      >
                        {(
                          ["left", "right", "bottom", "top", "none"] as const
                        ).map((position) => (
                          <option key={position} value={position}>
                            {
                              {
                                left: "Left",
                                right: "Right",
                                bottom: "Below",
                                top: "Above",
                                none: "None",
                              }[position]
                            }
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {chosen.kind === "list" && (
                    <div className="qt-metric-list-controls">
                      {(
                        ["showBars", "useGroupColors", "showValues"] as const
                      ).map((key) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            checked={chosen.list?.[key] !== false}
                            onChange={(e) =>
                              displayPatch({
                                list: {
                                  ...chosen.list,
                                  [key]: e.target.checked,
                                },
                              })
                            }
                          />
                          {
                            {
                              showBars: "Show line bars",
                              useGroupColors: "Use group colors",
                              showValues: "Show final values",
                            }[key]
                          }
                        </label>
                      ))}
                    </div>
                  )}
                  {chosen.kind === "table" && selected.groupBy.length === 2 && (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={chosen.pivot?.swap ?? false}
                          onChange={(e) =>
                            displayPatch({
                              pivot: {
                                ...chosen.pivot,
                                swap: e.target.checked,
                              },
                            })
                          }
                        />
                        Swap X/Y axes
                      </label>
                      {(["rowDir", "columnDir"] as const).map((key) => (
                        <label key={key}>
                          {key === "rowDir" ? "Row keys" : "Column keys"}
                          <select
                            value={chosen.pivot?.[key] ?? "asc"}
                            onChange={(e) =>
                              displayPatch({
                                pivot: {
                                  ...chosen.pivot,
                                  [key]: e.target.value as "asc" | "desc",
                                },
                              })
                            }
                          >
                            <option value="asc">Ascending</option>
                            <option value="desc">Descending</option>
                          </select>
                        </label>
                      ))}
                    </>
                  )}
                  {chosen.kind === "box" && selected.distribution && (
                    <>
                      <label>
                        Whiskers
                        <select
                          aria-label="Box whiskers"
                          value={selected.distribution.whiskers ?? "minmax"}
                          onChange={(e) =>
                            patch(selected.id, {
                              distribution: {
                                ...selected.distribution!,
                                whiskers: e.target.value as "minmax" | "tukey",
                              },
                            })
                          }
                        >
                          <option value="minmax">Minimum / maximum</option>
                          <option value="tukey">
                            1.5 × IQR · show outliers
                          </option>
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={chosen.boxMean !== false}
                          onChange={(e) =>
                            displayPatch({ boxMean: e.target.checked })
                          }
                        />
                        Show mean marker
                      </label>
                    </>
                  )}
                  {chosen.kind === "histogram" && selected.distribution && (
                    <label>
                      Equal-width bins
                      <MetricNumberInput
                        key={selected.id}
                        aria-label="Histogram bins"
                        min={2}
                        max={30}
                        step={1}
                        value={selected.distribution.bins ?? 10}
                        onCommit={(n) => {
                          if (Number.isInteger(n) && n >= 2 && n <= 30)
                            patch(selected.id, {
                              distribution: {
                                ...selected.distribution!,
                                bins: n,
                              },
                            });
                        }}
                      />
                    </label>
                  )}
                </Settings>
                <Settings
                  title="Labels"
                  {...settingsState("Labels")}
                  summary={
                    [chosen.valueLabel, chosen.xLabel, chosen.yLabel].some(
                      Boolean,
                    )
                      ? "Custom"
                      : "Automatic"
                  }
                >
                  {(["valueLabel", "xLabel", "yLabel"] as const).map((key) => (
                    <label key={key}>
                      {
                        {
                          valueLabel: "Value label",
                          xLabel: "X axis label",
                          yLabel: "Y axis label",
                        }[key]
                      }
                      <input
                        maxLength={1000}
                        value={chosen[key] ?? ""}
                        onChange={(e) =>
                          displayPatch({ [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                </Settings>
                <Settings
                  title="Card size"
                  {...settingsState("Card size")}
                  summary={`${(selected.layout ?? defaultLayout).widthRem} × ${(selected.layout ?? defaultLayout).heightRem} rem · min ${(selected.layout ?? defaultLayout).minWidthRem} × ${(selected.layout ?? defaultLayout).minHeightRem}`}
                >
                  {sizeControls}
                </Settings>
              </>
            ) : (
              <div className="qt-metric-authoring-empty">
                <Icon name="panelDefinition" size={28} />
                <strong>No metric selected</strong>
                <p>Create a metric to define what you want to measure.</p>
                <button type="button" className="qt-btn" onClick={createMetric}>
                  <Icon name="add" />
                  Create metric
                </button>
              </div>
            )}
          </section>
          {separator(1)}
          <aside
            className="qt-metric-reference"
            {...paneProps(2)}
            aria-label="Field and function library"
          >
            {paneHeading(2, "Fields & functions")}
            <select
              aria-label="Reference library"
              value={reference}
              onChange={(e) => setReference(e.target.value as typeof reference)}
            >
              <option value="fields">Fields</option>
              <option value="functions">Functions</option>
            </select>
            <label>
              Search {reference}
              <input
                aria-label="Search metric reference"
                type="search"
                placeholder="Name or purpose"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {reference === "functions" && (
              <label>
                Concept
                <select
                  aria-label="Function concept"
                  value={concept}
                  onChange={(e) => setConcept(e.target.value)}
                >
                  <option value="all">All functions</option>
                  <option value="aggregate">Aggregation</option>
                  <option value="row">Row arithmetic & conditions</option>
                </select>
              </label>
            )}
            <div className="qt-metric-reference-columns" aria-hidden="true">
              <span>Type</span>
              <span>Name</span>
              <span>{reference === "fields" ? "ID" : "Signature"}</span>
            </div>
            <div className="qt-metric-reference-list">
              {referenceItems.map((item) => (
                <button
                  type="button"
                  className="qt-metric-reference-item"
                  key={item.name}
                  title={`${item.label} · ${item.detail}
${item.description}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    insert(item.wrap ? item.name : item.detail, item.wrap)
                  }
                >
                  <span>{item.type}</span>
                  <strong>{item.label}</strong>
                  <code>
                    {reference === "fields" ? item.name : item.detail}
                  </code>
                </button>
              ))}
              {referenceItems.length === 0 && (
                <p className="qt-metric-help" role="status">
                  No {reference} match “{search}”.
                </p>
              )}
            </div>
            <p className="qt-metric-help">
              Insert at the cursor. Select expression text to wrap it in a
              function.
            </p>
          </aside>
          {separator(2)}
          <section className="qt-metric-live-preview" {...paneProps(3)}>
            <div className="qt-metric-preview-heading">
              <h3>Live preview</h3>
              <span className="qt-metric-preview-status" role="status">
                {previewLoading
                  ? "Calculating…"
                  : selectedResult?.error ||
                      error ||
                      (selected && diagnostics.has(selected.id))
                    ? "Needs attention"
                    : selectedResult?.coverage === "exact"
                      ? "Complete results"
                      : selectedResult?.coverage === "partial"
                        ? "Partial results"
                        : "Preview"}
              </span>
              {panelToggle(3, true)}
            </div>
            {selected && (
              <>
                <p className="qt-metric-preview-scope">
                  {selected.scope === "shownRows"
                    ? "Shown rows on this page"
                    : "All matching rows"}
                </p>
                <p className="qt-metric-help">
                  Aggregate input rows, then apply result ordering and display.
                </p>
                <div className="qt-metric-preview-controls">
                  <label>
                    Width (px)
                    <MetricNumberInput
                      key={selected.id}
                      aria-label="Preview width"
                      min={100}
                      max={1800}
                      value={previewSize.width}
                      onCommit={(n) => {
                        if (Number.isFinite(n))
                          setPreviewSize((previous) => ({
                            ...previous,
                            width: Math.max(100, Math.min(1800, n)),
                          }));
                      }}
                    />
                  </label>
                  <label>
                    Height (px)
                    <MetricNumberInput
                      key={selected.id}
                      aria-label="Preview height"
                      min={60}
                      max={1000}
                      value={previewSize.height}
                      onCommit={(n) => {
                        if (Number.isFinite(n))
                          setPreviewSize((previous) => ({
                            ...previous,
                            height: Math.max(60, Math.min(1000, n)),
                          }));
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="qt-btn"
                    onClick={() => {
                      const layout = selected.layout ?? defaultLayout;
                      const rem =
                        parseFloat(
                          getComputedStyle(document.documentElement).fontSize,
                        ) || 16;
                      setPreviewSize({
                        width: layout.widthRem * rem,
                        height: layout.heightRem * rem,
                      });
                    }}
                  >
                    Use card size
                  </button>
                  <button
                    type="button"
                    className="qt-btn qt-metric-refresh"
                    aria-label="Refresh preview"
                    title="Refresh preview"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                </div>
                <div
                  ref={previewContainer}
                  className="qt-metric-preview-card"
                  style={{
                    width: previewSize.width,
                    height: previewSize.height,
                  }}
                >
                  {card(selected)}
                </div>
                <p className="qt-metric-help">
                  Drag the lower-right corner to resize. Preview dimensions are
                  temporary.
                </p>
                {selectedResult?.processedRows !== undefined && (
                  <p className="qt-muted">
                    {selectedResult.processedRows.toLocaleString(locale)} input
                    rows · {selectedResult.buckets.length} of{" "}
                    {selectedResult.groupCount ?? selectedResult.buckets.length}{" "}
                    groups
                  </p>
                )}
                {inspectedBucket && (
                  <details
                    className="qt-metric-settings qt-metric-inspection"
                    open={inspectOpen}
                    onToggle={(e) => setInspectOpen(e.currentTarget.open)}
                  >
                    <summary>
                      <strong>Inspect result</strong>
                      <span>
                        {inspectedBucket.keys
                          .map((k) => (k === null ? "NULL" : String(k)))
                          .join(" / ") || "One value"}
                      </span>
                    </summary>
                    <div>
                      {selectedResult && selectedResult.buckets.length > 1 && (
                        <label>
                          Result group
                          <select
                            aria-label="Inspect result group"
                            value={JSON.stringify(inspectedBucket.keys)}
                            onChange={(e) => setInspectedKey(e.target.value)}
                          >
                            {selectedResult.buckets.map((b) => (
                              <option
                                key={JSON.stringify(b.keys)}
                                value={JSON.stringify(b.keys)}
                              >
                                {b.keys
                                  .map((k) => (k === null ? "NULL" : String(k)))
                                  .join(" / ")}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <MetricInspection
                        bucket={inspectedBucket}
                        clause={selected}
                        locale={locale}
                      />
                    </div>
                  </details>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {error && (
        <p className="qt-metric-editor-error" role="alert">
          {error}
        </p>
      )}
      {contextChanged && (
        <p className="qt-metric-editor-error" role="status">
          The metric configuration changed outside this draft.
        </p>
      )}
      <footer className="qt-metrics-editor-footer">
        <span className="qt-muted">
          {dirty
            ? "Unsaved changes"
            : "Changes stay in this draft until applied."}
        </span>
        {removed && (
          <button
            type="button"
            className="qt-btn qt-metric-undo-remove"
            title={`Restore ${titleOf(removed.clause, fields)}`}
            disabled={drafts.length >= MAX_AGGREGATIONS}
            onClick={() => {
              setDrafts((previous) => {
                const next = [...previous];
                next.splice(
                  Math.min(removed.position, next.length),
                  0,
                  removed.clause,
                );
                return next;
              });
              focusDestination.current = true;
              setNavigation((previous) => previous + 1);
              setActive(removed.clause.id);
              setAnnouncement(`${titleOf(removed.clause, fields)} restored.`);
              setRemoved(null);
            }}
          >
            <Icon name="undo" size={14} />
            Undo remove
          </button>
        )}
        {issues.size > 0 && (
          <button
            type="button"
            className="qt-btn qt-metric-review-issues"
            onClick={() => {
              workbench.showPane(3);
              navigate("editor", issues.keys().next().value);
            }}
          >
            <Icon name="alert" size={14} />
            Review {issues.size} {issues.size === 1 ? "issue" : "issues"}
          </button>
        )}
        <button type="button" className="qt-btn" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="qt-btn qt-btn-primary"
          disabled={
            diagnostics.size > 0 ||
            contextChanged ||
            !!error ||
            previewLoading ||
            !!preview?.metrics.some((m) => m.error)
          }
          onClick={apply}
        >
          Apply metrics
        </button>
      </footer>
      <div className="qt-sr-only" role="status" aria-live="polite">
        {announcement}
        {selectedPosition >= 0
          ? `Selected metric ${selectedPosition + 1} of ${drafts.length}`
          : ""}
      </div>
      {discard && (
        <ModalSurface
          title="Discard metric changes?"
          className="qt-modal qt-metric-discard"
          onClose={() => setDiscard(false)}
        >
          <div className="qt-overlay-body">
            <p>Your metric draft has not been applied.</p>
            <div className="qt-metric-discard-actions">
              <button
                type="button"
                className="qt-btn"
                onClick={() => setDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="qt-btn" onClick={onClose}>
                Discard changes
              </button>
            </div>
          </div>
        </ModalSurface>
      )}
    </ModalSurface>
  );

  function separator(index: number) {
    const next = workbench.nextPane(index);
    if (!workbench.visiblePanes[index] || next === undefined) return null;
    return (
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={`Resize metric panes ${index + 1} and ${next + 1}`}
        aria-controls={`${titleId}-pane-${index} ${titleId}-pane-${next}`}
        title={`Resize ${panes[index]!.label.toLowerCase()} and ${panes[next]!.label.toLowerCase()} panels`}
        aria-valuemin={workbench.minWidths[index]}
        aria-valuenow={Math.round(workbench.widths[index] ?? 0)}
        className="qt-metric-pane-separator"
        aria-valuemax={
          (workbench.widths[index] ?? 0) +
          (workbench.widths[next] ?? 0) -
          (workbench.minWidths[next] ?? 0)
        }
        aria-valuetext={`${Math.round(workbench.widths[index] ?? 0)} pixels`}
        onDoubleClick={workbench.resetPanes}
        onPointerDown={(e) => workbench.startResize(e, index)}
        onKeyDown={(e) => {
          if (e.key === "Home") {
            e.preventDefault();
            workbench.resetPanes();
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            workbench.stepResize(
              index,
              (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 50 : 10),
            );
          }
        }}
      />
    );
  }
}

function newId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `metric-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Preserve incomplete typing; bounds apply only on blur or Enter. */
function MetricNumberInput({
  value,
  onCommit,
  min,
  max,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur" | "onKeyDown" | "min" | "max"
> & {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && Number.isFinite(Number(draft)))
          onCommit(Math.max(min, Math.min(max, Math.round(Number(draft)))));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape" && draft !== null) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
function Settings({
  title,
  summary,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  summary: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details
      className="qt-metric-settings"
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
    >
      <summary>
        <strong>{title}</strong>
        <span>{summary}</span>
      </summary>
      <div>{children}</div>
    </details>
  );
}
function MetricFormatControls({
  format,
  onChange,
  displayControl,
  sample,
  locale,
}: {
  displayControl?: ReactNode;
  sample?: AggregationBucket["value"] | undefined;
  locale?: string | undefined;
  format: MetricValueFormat;
  onChange: (format: MetricValueFormat) => void;
}) {
  const temporal = !["number", "percent"].includes(format.kind),
    duration = format.kind === "duration";
  const patch = (values: Partial<MetricValueFormat>) =>
    onChange({ ...format, ...values });
  const units: Array<[NonNullable<MetricValueFormat["sourceUnit"]>, string]> =
    duration
      ? [
          ["milliseconds", "Milliseconds"],
          ["seconds", "Seconds"],
          ["minutes", "Minutes"],
          ["hours", "Hours"],
          ["days", "Days"],
        ]
      : [
          ["iso", "ISO text"],
          ["epochSeconds", "Unix seconds"],
          ["epochMilliseconds", "Unix milliseconds"],
          ...(format.kind === "time"
            ? ([
                ["secondsOfDay", "Seconds since midnight"],
                ["millisecondsOfDay", "Milliseconds since midnight"],
              ] as Array<
                [NonNullable<MetricValueFormat["sourceUnit"]>, string]
              >)
            : []),
        ];
  return (
    <div
      className={`qt-metric-format-controls${temporal ? " qt-metric-format-controls--temporal" : ""}`}
    >
      {displayControl}
      <label>
        Output type
        <select
          aria-label="Metric output type"
          value={format.kind}
          onChange={(e) =>
            onChange({
              kind: e.target.value as MetricValueFormat["kind"],
              decimals: format.decimals ?? 0,
              sourceUnit:
                e.target.value === "duration" ? "milliseconds" : "iso",
              style: "human",
              timeZone: "UTC",
            })
          }
        >
          {(
            [
              "number",
              "percent",
              "duration",
              "date",
              "time",
              "datetime",
            ] as const
          ).map((kind) => (
            <option key={kind} value={kind}>
              {
                {
                  number: "Number",
                  percent: "Percent",
                  duration: "Duration",
                  date: "Date",
                  time: "Time",
                  datetime: "Date & time",
                }[kind]
              }
            </option>
          ))}
        </select>
      </label>
      {!temporal && (
        <label>
          Decimals
          <MetricNumberInput
            aria-label="Metric decimals"
            min={0}
            max={6}
            step={1}
            value={format.decimals ?? 0}
            onCommit={(n) => {
              if (Number.isInteger(n) && n >= 0 && n <= 6)
                patch({ decimals: n });
            }}
          />
        </label>
      )}
      {temporal && (
        <div className="qt-metric-temporal-controls">
          <label>
            Source units / encoding
            <select
              aria-label="Source units"
              value={format.sourceUnit ?? (duration ? "milliseconds" : "iso")}
              onChange={(e) =>
                patch({
                  sourceUnit: e.target.value as NonNullable<
                    MetricValueFormat["sourceUnit"]
                  >,
                })
              }
            >
              {units.map(([unit, label]) => (
                <option value={unit} key={unit}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Label format
            <select
              aria-label="Label format"
              value={format.style ?? "human"}
              onChange={(e) =>
                patch({
                  style: e.target.value as NonNullable<
                    MetricValueFormat["style"]
                  >,
                  pattern:
                    format.pattern ??
                    (duration
                      ? "{h}h{m}m"
                      : format.kind === "time"
                        ? "HH:mm:ss"
                        : format.kind === "date"
                          ? "YYYY-MM-DD"
                          : "YYYY-MM-DD HH:mm:ss"),
                })
              }
            >
              <option value="human">
                {duration
                  ? "Human readable"
                  : format.kind === "time"
                    ? "24-hour"
                    : "Readable"}
              </option>
              {duration ? (
                <>
                  <option value="long">Long</option>
                  <option value="clock">Clock · total hours</option>
                </>
              ) : (
                <option value="iso">{"ISO-style"}</option>
              )}
              <option value="custom">Custom format string</option>
            </select>
          </label>
          {format.style === "custom" && (
            <label>
              Format string
              <input
                aria-label="Output format string"
                maxLength={160}
                value={format.pattern ?? ""}
                onChange={(e) => patch({ pattern: e.target.value })}
              />
              <span className="qt-muted">
                {duration
                  ? "{d} {h} {hh} {m} {mm} {s} {ss} {ms}"
                  : "YYYY MM DD MMM MMMM ddd HH hh mm ss SSS A Z; [literal text]"}
              </span>
            </label>
          )}
          {!duration &&
            !["secondsOfDay", "millisecondsOfDay"].includes(
              format.sourceUnit ?? "",
            ) && (
              <label>
                Timezone
                <input
                  aria-label="Output timezone"
                  maxLength={80}
                  value={format.timeZone ?? "UTC"}
                  placeholder="UTC, local, or America/Denver"
                  onChange={(e) => patch({ timeZone: e.target.value })}
                />
              </label>
            )}
        </div>
      )}
      <div className="qt-metric-format-example">
        <span>Format example</span>
        <strong>
          {
            formatMetricOutput(
              sample === undefined
                ? format.kind === "date" || format.kind === "datetime"
                  ? "2026-10-08T14:30:00Z"
                  : format.kind === "time"
                    ? "14:30:00"
                    : format.kind === "duration"
                      ? 83400
                      : 0.875
                : sample,
              format,
              locale,
            ).text
          }
        </strong>
      </div>
    </div>
  );
}

function MetricInspection({
  bucket,
  clause,
  locale,
}: {
  bucket: AggregationBucket;
  clause: AggregationClause;
  locale?: string | undefined;
}) {
  const rows: Array<[string, string]> = [
    ["Input rows", bucket.count.toLocaleString(locale)],
  ];
  const box =
    bucket.distribution?.kind === "box" ? bucket.distribution.summary : null;
  if (box)
    for (const key of ["min", "q1", "median", "q3", "max", "mean"] as const)
      rows.push([
        {
          min: "Minimum",
          q1: "First quartile",
          median: "Median",
          q3: "Third quartile",
          max: "Maximum",
          mean: "Mean",
        }[key],
        formatMetricOutput(box[key], clause.display?.format, locale).text,
      ]);
  else {
    rows.push(["Raw value", String(bucket.value ?? "NULL")]);
    if (clause.display?.kind === "scatter")
      rows.push(["Raw Y value", String(bucket.y ?? "NULL")]);
  }
  if (bucket.distribution)
    rows.push(
      [
        "Numeric samples",
        String(
          bucket.distribution.kind === "box"
            ? (bucket.distribution.summary?.n ?? 0)
            : bucket.distribution.n,
        ),
      ],
      ["NULL values", String(bucket.nullCount ?? 0)],
    );
  return (
    <>
      <code className="qt-metric-inspection-expression">
        {clause.distribution &&
        ["box", "histogram"].includes(clause.display?.kind ?? "")
          ? clause.distribution.input
          : metricExpression(clause)}
      </code>
      <dl className="qt-metric-inspection-values">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {bucket.error && <p className="qt-metric-editor-error">{bucket.error}</p>}
    </>
  );
}

function simpleAggregate(
  clause: AggregationClause,
  fields: FieldDef[],
): { op: AggregationClause["op"]; field?: string } | undefined {
  try {
    const ast = compileMetric(metricExpression(clause), fields).ast;
    if (
      ast.kind !== "call" ||
      !["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"].includes(
        ast.name,
      )
    )
      return;
    if (ast.args.length === 0 && ast.name === "COUNT") return { op: "count" };
    if (ast.args.length === 1 && ast.args[0]?.kind === "field")
      return {
        op: ast.name.toLowerCase() as AggregationClause["op"],
        field: ast.args[0].name,
      };
  } catch {
    return;
  }
}
