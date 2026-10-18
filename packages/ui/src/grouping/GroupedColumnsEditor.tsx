import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyQuery,
  compileMetric,
  FORMULA_FUNCTIONS,
  METRIC_FUNCTIONS,
  isComputedCellError,
  predicatesOf,
  readFieldValue,
  isSelectable,
  isComputedField,
  type ColumnPreview,
  type SelectColumn,
} from "@pythia-software/query-table-core";
import { EditorContext, EditorPaneTitle, EditorChoice } from "../EditorParts";
import FormulaEditor, { type FormulaEditorActions } from "../FormulaEditor";
import { FormulaFunctionBrowser } from "../FormulaFunctionBrowser";
import { FieldPicker } from "../FieldPicker";
import { Icon, type IconName } from "../Icon";
import {
  EditorModal,
  EditorPanelToggle,
  EditorPanelSeparator,
} from "../EditorModal";
import { useEditorWorkbench } from "../useEditorWorkbench";
import { useMobileLayout } from "../AdaptiveOverlay";
import { PickerAnchor } from "../PickerAnchor";
import { ReorderList } from "../ReorderList";
import { SelectColumnEditor } from "../SelectColumnEditor";
import {
  defaultRenderers,
  resolveRenderer,
  type RenderRegistry,
} from "../renderers";
import {
  availableSummaryOps,
  ColumnPicker,
  SUMMARY_NAMES,
} from "./ColumnPicker";
import {
  OP_LABEL,
  type SummaryColumn,
  type SummaryOp,
  type GroupedRow as Row,
} from "@pythia-software/query-table-core";
import type { GroupingApi } from "@pythia-software/query-table-react";
import { columnRole, ColumnRoleBadge } from "./ColumnRole";
import { SummaryFormatControl } from "./SummaryFormatControl";
type Controller = GroupingApi<Row>;
const panes: Array<{
  label: string;
  icon: IconName;
  width: number;
  minWidth: number;
  defaultVisible?: boolean;
}> = [
  { label: "Columns", icon: "panelList", width: 240, minWidth: 190 },
  { label: "Column", icon: "panelDefinition", width: 420, minWidth: 280 },
  {
    label: "Functions",
    icon: "panelReference",
    width: 280,
    minWidth: 230,
    defaultVisible: false,
  },
  { label: "Preview", icon: "panelPreview", width: 430, minWidth: 240 },
];
const aggregateFunctions = [...METRIC_FUNCTIONS, ...FORMULA_FUNCTIONS];
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const valueText = (value: unknown) =>
  value == null ? "—" : Array.isArray(value) ? value.join(", ") : String(value);

export function GroupedColumnsEditor({
  controller,
  onClose,
  renderers = defaultRenderers,
  initialFormulaField,
}: {
  initialFormulaField?: string;
  controller: Controller;
  onClose: () => void;
  renderers?: RenderRegistry<Row>;
}) {
  const { api, view, model } = controller;
  const {
    groupRows,
    inputSchema,
    resultSchema,
    representativeLabel,
    sourceField,
    summaryFields,
    summaryExpression,
    summaryProblem,
  } = model;
  const mobile = useMobileLayout();
  const panelId = useId();
  const panelScroll = useRef([0, 0, 0, 0]);
  const formulaActions = useRef<FormulaEditorActions>(null);
  const grouping = view.mode === "groups";
  const initial = useRef({
    columns: copy(api.select.visible),
    summaries: copy(view.summaries),
  });
  const newFormula = useRef<SummaryColumn | null>(
    initialFormulaField && initial.current.summaries.length < 64
      ? {
          id: `summary_${crypto.randomUUID().replace(/-/g, "")}`,
          op: "formula" as const,
          field: initialFormulaField,
          expression: `${sourceField(initialFormulaField)?.type === "number" ? "AVG" : "COUNT"}([${initialFormulaField.replace(/\]/g, "]]")}])`,
          label: "Custom aggregate",
        }
      : null,
  );
  const context = useRef(JSON.stringify(view));
  const [columns, setColumns] = useState(() =>
    newFormula.current
      ? [...initial.current.columns, { field: newFormula.current.id }]
      : initial.current.columns,
  );
  const [summaries, setSummaries] = useState(() =>
    newFormula.current
      ? [...initial.current.summaries, newFormula.current]
      : initial.current.summaries,
  );
  const representative = view.representative;
  const [active, setActive] = useState(
    newFormula.current?.id ?? columns[0]?.field ?? "",
  );
  const [addSource, setAddSource] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [changingField, setChangingField] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [panel, setPanel] = useState("definition");
  const [preview, setPreview] = useState<ColumnPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState(
    initialFormulaField && !newFormula.current
      ? "This view supports up to 64 summaries."
      : "",
  );
  const [removed, setRemoved] = useState<{
    column: SelectColumn;
    index: number;
    summary?: SummaryColumn;
  } | null>(null);
  const schema = useMemo(
    () => (grouping ? resultSchema(view.keys, summaries) : controller.schema),
    [grouping, view.keys, summaries, controller.schema],
  );
  const fields = [
    ...schema.fields,
    ...api.computed.catalogue.filter(
      (f) => !schema.fields.some((s) => s.name === f.name),
    ),
  ].filter(isSelectable);
  const selected = summaries.find((s) => s.id === active);
  const editingAggregate = grouping && selected?.op === "formula";
  const workbench = useEditorWorkbench(panes.map((pane, index) =>
    index === 2 ? { ...pane, defaultVisible: editingAggregate } : pane,
  ));
  // Follow the selected column, not each keystroke: manual panel choices last
  // until the user selects another column or changes its kind.
  useLayoutEffect(() => {
    if (editingAggregate) workbench.showPane(2);
    else {
      if (workbench.visibleIndices.length === 1 && workbench.visiblePanes[2])
        workbench.showPane(1);
      workbench.hidePane(2);
      setPanel((current) => (current === "functions" ? "definition" : current));
    }
  }, [active, editingAggregate]);
  const chosen = fields.find((f) => f.name === active);
  const isKey = grouping && view.keys.includes(active);
  const draftContext = {
    mode: view.mode,
    keys: view.keys,
    summaries,
    representative,
  };
  const chosenRole = columnRole(active, draftContext);
  const availableOps = (field?: string) =>
    availableSummaryOps(
      model,
      field,
      summaries,
      columns.map((c) => c.field),
      representative,
      active,
    );
  const changed = new Set(
    initial.current.summaries
      .filter((before) => {
        const after = summaries.find((s) => s.id === before.id);
        return (
          !after ||
          before.op !== after.op ||
          before.field !== after.field ||
          before.expression !== after.expression
        );
      })
      .map((s) => s.id),
  );
  const summaryDraftChanged =
    grouping &&
    JSON.stringify(summaries) !== JSON.stringify(initial.current.summaries);
  const dirty =
    JSON.stringify({ columns, summaries }) !== JSON.stringify(initial.current);
  const reconciled = api.query;
  const impactedFilters =
    api.query.where.length -
    reconciled.where.filter(
      (term) => !predicatesOf(term).some((p) => changed.has(p.field)),
    ).length;
  const impactedSorts =
    api.query.orderBy.length -
    reconciled.orderBy.filter((term) => !changed.has(term.field)).length;
  const impactedMetrics = changed.size
    ? api.aggregations.clauses.length
    : api.aggregations.clauses.length - (reconciled.aggregations?.length ?? 0);
  const impact = [
    impactedMetrics &&
      `${impactedMetrics} metric${impactedMetrics === 1 ? "" : "s"}`,
    impactedFilters &&
      `${impactedFilters} group filter${impactedFilters === 1 ? "" : "s"}`,
    impactedSorts && `${impactedSorts} sort${impactedSorts === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(", ");
  const previewQuery = useMemo(() => {
    const changedFields = new Set(initial.current.summaries.filter(before => {
      const after = summaries.find(summary => summary.id === before.id);
      return !after || before.op !== after.op || before.field !== after.field || before.expression !== after.expression;
    }).map(summary => summary.id));
    return { ...api.query, ...view.result, grouping: { ...api.query.grouping!, source: view.input, keys: view.keys, summaries, representative },
      select: columns, where: view.result.where.filter(term => !predicatesOf(term).some(predicate => changedFields.has(predicate.field))),
      orderBy: view.result.orderBy.filter(term => !changedFields.has(term.field)), limit: 8, offset: 0 };
  }, [view.input, view.keys, view.result, columns, summaries, representative]);
  const previewKey = JSON.stringify({ ...previewQuery, select: previewQuery.select.map(column => ({ field: column.field })) });
  const [remotePreview, setRemotePreview] = useState<{ key: string; rows: Row[]; sourceTotal?: number; error: string | null; loading: boolean } | null>(null);
  useEffect(() => {
    if (!grouping || !controller.preview) return;
    const controllerAbort = new AbortController();
    setRemotePreview({ key: previewKey, rows: [], error: null, loading: true });
    void controller.preview(previewQuery, controllerAbort.signal).then(result => {
      if (!controllerAbort.signal.aborted) setRemotePreview({ key: previewKey, rows: result.rows as Row[], sourceTotal: result.sourceTotal, error: null, loading: false });
    }).catch(error => { if (!controllerAbort.signal.aborted) setRemotePreview({ key: previewKey, rows: [], error: error instanceof Error ? error.message : String(error), loading: false }); });
    return () => controllerAbort.abort();
  }, [grouping, controller.preview, previewKey]);
  const groupPreview = useMemo(() => {
    if (controller.preview) return remotePreview?.key === previewKey ? remotePreview : { rows: [] as Row[], error: null, loading: true };
    if (!grouping) return { rows: [] as Row[], error: null };
    try {
      if (controller.inputsReady === false) throw Error("Wait for the complete source before previewing groups.");
      model.validate({ ...api.query.grouping, keys: view.keys, summaries, representative });
      const rows = groupRows(
        controller.inputs,
        inputSchema,
        view.keys,
        summaries,
        representative,
      );
      const query = view.result;
      const changedFields = new Set(
        initial.current.summaries
          .filter((before) => {
            const after = summaries.find((s) => s.id === before.id);
            return (
              !after ||
              before.op !== after.op ||
              before.field !== after.field ||
              before.expression !== after.expression
            );
          })
          .map((s) => s.id),
      );
      return {
        rows: applyQuery(
          rows,
          {
            ...query,
            select: columns,
            where: query.where.filter(
              (t) => !predicatesOf(t).some((p) => changedFields.has(p.field)),
            ),
            orderBy: query.orderBy.filter((t) => !changedFields.has(t.field)),
            limit: 8,
            offset: 0,
          },
          schema,
        ).rows,
        error: null,
      };
    } catch (cause) {
      return {
        rows: [] as Row[],
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [
    grouping,
    controller.preview,
    controller.inputsReady,
    remotePreview,
    previewKey,
    controller.inputs,
    view.keys,
    view.result,
    summaries,
    schema,
    columns,
    representative,
    model,
    api.query.grouping,
    controller.schema,
    api.computed.catalogue,
  ]);
  const request = useRef(api.computed.preview);
  request.current = api.computed.preview;
  const needsComputedPreview = !grouping || isComputedField(active);
  const deferredPreview = isComputedField(active) && summaryDraftChanged;
  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (!active || !needsComputedPreview || deferredPreview) return;
    const ac = new AbortController();
    request
      .current(`[${active.replace(/\]/g, "]]")}]`, 1000, ac.signal)
      .then((result) => {
        if (!ac.signal.aborted) setPreview(result);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setPreviewError(String(e));
      });
    return () => ac.abort();
  }, [active, needsComputedPreview, deferredPreview]);
  function focus(field: string) {
    setActive(field);
    setPanel("definition");
    setChangingField(false);
    workbench.showPane(1);
  }
  function addField(field: string) {
    setColumns((cols) =>
      cols.some((c) => c.field === field) ? cols : [...cols, { field }],
    );
    focus(field);
  }
  function addSummary(op: SummaryOp, field?: string) {
    const existing =
      op === "formula"
        ? undefined
        : summaries.find((s) => s.op === op && s.field === field);
    if (!existing && summaries.length >= 64) {
      setError("This view supports up to 64 summaries.");
      return;
    }
    const next = existing ?? {
      id: `summary_${crypto.randomUUID().replace(/-/g, "")}`,
      op,
      ...(field ? { field } : {}),
      ...(op === "formula"
        ? {
            expression: field
              ? `${sourceField(field)?.type === "number" ? "AVG" : "COUNT"}([${field.replace(/\]/g, "]]")}])`
              : "COUNT()",
            label: "Custom aggregate",
          }
        : {}),
    };
    if (!existing) setSummaries((s) => [...s, next]);
    addField(next.id);
  }
  function patchSummary(patch: {
    [K in keyof SummaryColumn]?: SummaryColumn[K] | undefined;
  }) {
    setSummaries((s) =>
      s.map((c) => {
        if (c.id !== active) return c;
        const next = { ...c, ...patch };
        if (next.display === undefined) delete next.display;
        return next as SummaryColumn;
      }),
    );
  }
  function move(field: string, index: number) {
    setColumns((cols) => {
      const next = cols.filter((c) => c.field !== field);
      const col = cols.find((c) => c.field === field);
      if (col) next.splice(index, 0, col);
      return next;
    });
  }
  function remove(field: string) {
    const index = columns.findIndex((c) => c.field === field);
    const summary = summaries.find((s) => s.id === field);
    setRemoved({
      column: columns[index]!,
      index,
      ...(summary ? { summary } : {}),
    });
    const invalid = (column: SummaryColumn) => column.op === "formula"
      ? Boolean(summaryProblem(column))
      : !model.allowedOps(column.field).includes(column.op) ||
        (column.op === "row" && (!column.field || !representative));
    const original = initial.current.summaries.find((s) => s.id === field);
    // Removing a new column cancels its definition. Existing valid summaries
    // stay in the catalogue; invalid edits revert to a valid original. Undo
    // retains the removed draft in all cases.
    if (summary && (!original || invalid(summary))) {
      setSummaries((current) =>
        original && !invalid(original)
          ? current.map((s) => (s.id === field ? original : s))
          : current.filter((s) => s.id !== field),
      );
    }
    setColumns((cols) => cols.filter((c) => c.field !== field));
    if (active === field)
      setActive(columns[index + 1]?.field ?? columns[index - 1]?.field ?? "");
  }
  function close() {
    if (dirty) setDiscard(true);
    else onClose();
  }
  function apply() {
    if (context.current !== JSON.stringify(controller.view)) {
      setError(
        "The query changed while this editor was open. Reopen columns to use the current view.",
      );
      return;
    }
    if (formulaIssue) {
      setError(formulaIssue);
      return;
    }
    try {
      controller.applyColumns(summaries, columns);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const fieldName = selected?.field
    ? sourceField(selected.field)?.label
    : selected
      ? "Rows"
      : chosen?.label;
  const formulaIssue =
    summaries.map(summaryProblem).find(Boolean) ?? groupPreview.error;
  const previewFields = grouping
    ? [...view.keys.filter((k) => k !== active), ...(chosen ? [active] : [])]
        .map((name) => fields.find((f) => f.name === name))
        .filter((f) => !!f)
    : [];
  function toggle(index: number, collapse = false) {
    const pane = panes[index]!;
    return (
      <EditorPanelToggle
        workbench={workbench}
        index={index}
        label={pane.label}
        icon={pane.icon}
        paneId={`${panelId}-${index}`}
        collapse={collapse}
      />
    );
  }
  function paneProps(index: number) {
    return {
      id: `${panelId}-${index}`,
      hidden: !mobile && !workbench.visiblePanes[index],
      ref: (element: HTMLElement | null) => {
        if (element) element.scrollTop = panelScroll.current[index] ?? 0;
      },
      onScroll: (event: React.UIEvent<HTMLElement>) => {
        panelScroll.current[index] = event.currentTarget.scrollTop;
      },
    };
  }
  function separator(index: number) {
    return (
      <EditorPanelSeparator
        workbench={workbench}
        index={index}
        label={`Resize column panels ${index + 1} and ${(workbench.nextPane(index) ?? index) + 1}`}
        controls={`${panelId}-${index} ${panelId}-${workbench.nextPane(index)}`}
      />
    );
  }
  return (
    <EditorModal
      title="Select columns"
      className="qt-columns-editor"
      closeLabel="Close column editor"
      onClose={close}
      workbench={workbench}
      headerActions={
        <>
          <span className="qt-muted">{columns.length} selected</span>
          {dirty && <span className="qt-column-draft">Unsaved changes</span>}
        </>
      }
      panelControls={
        <div
          className="qt-column-panel-tools qt-metric-panel-tools"
          role="group"
          aria-label="Visible column panels"
        >
          <span>Panels</span>
          {panes.map((pane, index) => (
            <span key={pane.label}>{toggle(index)}</span>
          ))}
        </div>
      }
    >
      <EditorContext
        shown={api.rows.length}
        total={api.total}
        filters={api.query.where.length}
        noun={grouping ? "groups" : "rows"}
      />
      <nav
        className="qt-columns-mobile-nav"
        aria-label="Column editor sections"
      >
        {[
          ["columns", `Columns (${columns.length})`],
          ["definition", "Column"],
          ["functions", "Functions"],
          ["preview", "Preview"],
        ].map(([id, name]) => (
          <button
            type="button"
            className="qt-btn"
            key={id}
            aria-pressed={panel === id}
            onClick={() => {
              setPanel(id!);
              workbench.showPane(
                ["columns", "definition", "functions", "preview"].indexOf(id!),
              );
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      <div
        ref={workbench.root}
        className={`qt-columns-workspace qt-columns-workspace--${panel}`}
        style={mobile ? undefined : {
          gridTemplateColumns: workbench.visibleIndices
            .map((i) => `${workbench.widths[i]}px`)
            .join(" 6px "),
        }}
      >
        <aside className="qt-columns-library" {...paneProps(0)}>
          <EditorPaneTitle actions={toggle(0, true)}>
            Columns <span className="qt-muted">{columns.length}</span>
          </EditorPaneTitle>
          <ReorderList
            items={columns.map((c) => ({
              id: c.field,
              label: fields.find((f) => f.name === c.field)?.label ?? c.field,
            }))}
            onMove={move}
            showHint={false}
            className="qt-column-items"
            itemClassName={(item) => (item.id === active ? "is-active" : "")}
            renderItem={(item) => {
              const s = summaries.find((s) => s.id === item.id);
              return (
                <>
                  <button
                    type="button"
                    className="qt-column-item-name"
                    title={item.label}
                    data-column-role={columnRole(item.id, draftContext)?.kind}
                    aria-pressed={item.id === active}
                    onClick={() => focus(item.id)}
                  >
                    <strong
                      className="qt-column-label"
                      data-column-role={columnRole(item.id, draftContext)?.kind}
                    >
                      {grouping && (
                        <span
                          className="qt-column-item-role"
                          aria-hidden="true"
                        >
                          <ColumnRoleBadge
                            role={columnRole(item.id, draftContext)}
                          />
                        </span>
                      )}
                      <span className="qt-column-item-label">{item.label}</span>
                    </strong>
                    <small>
                      {grouping && view.keys.includes(item.id)
                        ? "Group key"
                        : s
                          ? s.op === "formula"
                            ? s.expression
                            : s.field
                              ? `${sourceField(s.field)?.label} · ${OP_LABEL[s.op]}`
                              : "Count all rows"
                          : "Individual value"}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="qt-icon-btn"
                    aria-label={`Remove ${item.label}`}
                    onClick={() => remove(item.id)}
                  >
                    <Icon name="close" />
                  </button>
                </>
              );
            }}
          />
          <PickerAnchor>
            <button
              type="button"
              className="qt-btn qt-column-add"
              aria-label="Add column to view"
              aria-expanded={adding}
              aria-haspopup="dialog"
              disabled={columns.length >= 200}
              onClick={() => {
                setAddSource(undefined);
                setAdding(!adding);
              }}
            >
              <Icon name="add" />
              Add column
            </button>
            {adding &&
              (grouping ? (
                <ColumnPicker
                  model={model}
                  initialField={addSource}
                  keys={view.keys}
                  summaries={summaries}
                  representative={representative}
                  fields={fields}
                  selected={columns.map((c) => c.field)}
                  onField={addField}
                  onSummary={addSummary}
                  onCustom={(field) => addSummary("formula", field)}
                  onClose={() => setAdding(false)}
                />
              ) : (
                <FieldPicker
                  title="Add column"
                  fields={fields}
                  excluded={columns.map((c) => c.field)}
                  onPick={(f) => {
                    addField(f.name);
                    setAdding(false);
                  }}
                  onClose={() => setAdding(false)}
                />
              ))}
          </PickerAnchor>
          {grouping && (
            <button
              type="button"
              className="qt-btn qt-column-add qt-column-custom-add"
              disabled={summaries.length >= 64 || columns.length >= 200}
              onClick={() => addSummary("formula")}
            >
              <Icon name="add" /> Custom aggregate
            </button>
          )}
          {removed && (
            <div className="qt-column-removed" role="status">
              Column removed.{" "}
              <button
                type="button"
                className="qt-link-btn"
                onClick={() => {
                  const { column, index, summary } = removed;
                  if (summary)
                    setSummaries((current) =>
                      current.some((s) => s.id === summary.id)
                        ? current.map((s) =>
                            s.id === summary.id ? summary : s,
                          )
                        : [...current, summary],
                    );
                  setColumns((cols) => {
                    const next = cols.filter((c) => c.field !== column.field);
                    next.splice(index, 0, column);
                    return next;
                  });
                  focus(column.field);
                  setRemoved(null);
                }}
              >
                Undo
              </button>
            </div>
          )}
          <button
            type="button"
            className="qt-link-btn qt-column-advanced"
            disabled={summaryDraftChanged}
            title={
              summaryDraftChanged
                ? "Apply summary changes before editing computed columns"
                : "Explore values and computed definitions"
            }
            onClick={() => setAdvanced(true)}
          >
            Computed columns…
          </button>
        </aside>
        {separator(0)}
        <section className="qt-columns-definition" {...paneProps(1)}>
          <EditorPaneTitle actions={toggle(1, true)}>Column</EditorPaneTitle>
          {chosen ? (
            <>
              <h3
                className="qt-column-title qt-column-label"
                data-column-role={chosenRole?.kind}
              >
                <ColumnRoleBadge role={chosenRole} />
                {chosen.label}
              </h3>
              {selected?.op === "formula" ? (
                <div className="qt-column-formula">
                  <label className="qt-column-name">
                    Column name
                    <input
                      className="qt-input"
                      aria-label="Aggregate column name"
                      maxLength={1000}
                      value={selected.label ?? ""}
                      onChange={(event) =>
                        patchSummary({ label: event.target.value })
                      }
                    />
                  </label>
                  <div className="qt-column-field-label">Aggregate formula</div>
                  <FormulaEditor
                    actionsRef={formulaActions}
                    value={summaryExpression(selected)}
                    onChange={(expression) => patchSummary({ expression })}
                    fields={inputSchema.fields}
                    functions={aggregateFunctions}
                    showLibrary={false}
                    compile={(expression) =>
                      compileMetric(expression, inputSchema)
                    }
                    ariaLabel="Aggregate column formula"
                    rows={5}
                  />
                  <SummaryFormatControl
                    display={selected.display}
                    onChange={(display) => patchSummary({ display })}
                  />
                </div>
              ) : (
                <>
                  <div className="qt-column-field-label">Field</div>
                  {selected?.field ? (
                    <PickerAnchor>
                      <button
                        type="button"
                        className="qt-btn qt-column-source"
                        aria-label="Change source field"
                        aria-expanded={changingField}
                        onClick={() => setChangingField(!changingField)}
                      >
                        {fieldName}
                        <Icon name="chevronDown" />
                      </button>
                      {changingField && (
                        <FieldPicker
                          title="Change field"
                          fields={summaryFields.filter((f) =>
                            availableOps(f.name).includes(selected.op),
                          )}
                          onPick={(f) => {
                            patchSummary({ field: f.name });
                            setChangingField(false);
                          }}
                          onClose={() => setChangingField(false)}
                        />
                      )}
                    </PickerAnchor>
                  ) : (
                    <div className="qt-column-source-value">
                      {fieldName}
                      <span
                        className="qt-type-badge"
                        data-column-role={chosenRole?.kind}
                      >
                        {isKey
                          ? "Group key"
                          : selected
                            ? "All rows"
                            : chosen.type}
                      </span>
                    </div>
                  )}
                  {selected?.field ? (
                    <>
                      <div
                        className="qt-column-field-label"
                        data-column-role="aggregate"
                      >
                        Aggregate values
                      </div>
                      <div
                        className="qt-column-choices"
                        data-column-role="aggregate"
                        role="group"
                        aria-label="Summary choices"
                      >
                        {availableOps(selected.field)
                          .filter((op) => op !== "row")
                          .map((op) => (
                            <EditorChoice
                              key={op}
                              title={SUMMARY_NAMES[op]}
                              code={OP_LABEL[op]}
                              selected={selected.op === op}
                              onClick={() => patchSummary({ op })}
                            />
                          ))}
                      </div>
                      {selected.op !== "row" && (
                        <SummaryFormatControl
                          display={selected.display}
                          onChange={(display) => patchSummary({ display })}
                        />
                      )}
                      <button
                        type="button"
                        className="qt-btn qt-column-custom-choice"
                        data-column-role="aggregate"
                        onClick={() =>
                          patchSummary({
                            op: "formula",
                            expression: summaryExpression(selected),
                            label: chosen.label,
                          })
                        }
                      >
                        <Icon name="add" /> Custom aggregate…
                        <ColumnRoleBadge
                          role={{
                            kind: "aggregate",
                            badge: OP_LABEL.formula,
                            title: "Custom aggregate formula",
                          }}
                        />
                      </button>
                      {representative &&
                        availableOps(selected.field).includes("row") && (
                          <div
                            className="qt-column-row-choice"
                            data-column-role="row"
                          >
                            <div className="qt-column-field-label">
                              From representative row
                            </div>
                            <EditorChoice
                              title="Representative row"
                              detail={representativeLabel(representative)}
                              code="ROW"
                              selected={selected.op === "row"}
                              // Row values keep the source field's rendering;
                              // the Format control is hidden for them.
                              onClick={() =>
                                patchSummary({ op: "row", display: undefined })
                              }
                            />
                          </div>
                        )}
                      <button
                        type="button"
                        className="qt-link-btn qt-column-another"
                        onClick={() => {
                          setAddSource(selected.field);
                          setAdding(true);
                          setPanel("columns");
                          workbench.showPane(0);
                        }}
                      >
                        Add another {fieldName} column
                      </button>
                    </>
                  ) : (
                    <div className="qt-column-value-rule">
                      <Icon name={isKey ? "panelList" : "check"} />
                      <span>
                        {isKey
                          ? "Groups with the same value share a row."
                          : selected
                            ? "Number of rows in each group."
                            : "Show the value from each run."}
                      </span>
                    </div>
                  )}
                </>
              )}
              {impact && (
                <p className="qt-column-impact" role="status">
                  Applying this change clears {impact}. Undo in the query
                  restores them.
                </p>
              )}
            </>
          ) : (
            <div className="qt-column-empty">
              <Icon name="panelList" size={28} />
              <h3>Choose a column</h3>
              <p>Select a column on the left, or add a field.</p>
              <button
                type="button"
                className="qt-btn"
                onClick={() => {
                  setAdding(true);
                  setPanel("columns");
                  workbench.showPane(0);
                }}
              >
                Add a field
              </button>
            </div>
          )}
        </section>
        {separator(1)}
        <section className="qt-columns-functions" {...paneProps(2)}>
          <EditorPaneTitle actions={toggle(2, true)}>
            Function library
          </EditorPaneTitle>
          <FormulaFunctionBrowser
            variant="panel"
            functions={grouping ? aggregateFunctions : FORMULA_FUNCTIONS}
            {...(editingAggregate
              ? {
                  onInsert: (name: string) => {
                    workbench.showPane(1);
                    setPanel("definition");
                    requestAnimationFrame(() =>
                      formulaActions.current?.insertFunction(name),
                    );
                  },
                }
              : {})}
          />
        </section>
        {separator(2)}
        <section className="qt-columns-preview" {...paneProps(3)}>
          <EditorPaneTitle actions={toggle(3, true)}>
            Live preview <span className="qt-live-dot" />
          </EditorPaneTitle>
          {chosen && (
            <>
              <div className="qt-column-preview-heading">
                <strong
                  className="qt-column-label"
                  data-column-role={chosenRole?.kind}
                >
                  {chosen.label}
                </strong>
                <span>
                  {isKey
                    ? "Group key"
                    : selected
                      ? OP_LABEL[selected.op]
                      : chosen.type}
                </span>
              </div>
              {deferredPreview ? (
                <p className="qt-muted">
                  Apply summary changes to preview this computed column.
                </p>
              ) : needsComputedPreview ? (
                previewError ? (
                  <p role="alert">{previewError}</p>
                ) : !preview ? (
                  <p role="status">Loading preview…</p>
                ) : (
                  <>
                    <div className="qt-column-preview-scroll">
                      <table className="qt-preview-table">
                        <thead>
                          <tr>
                            <th>Value</th>
                            <th>Rows</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.groups.slice(0, 8).map((g, i) => (
                            <tr key={i}>
                              <td>
                                {g.result.error ?? valueText(g.result.value)}
                              </td>
                              <td>{g.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="qt-column-preview-note">
                      {preview.processed.toLocaleString()} rows sampled ·{" "}
                      {preview.groups.length} distinct values
                    </p>
                  </>
                )
              ) : (
                <>
                  <div className="qt-column-preview-scroll">
                    <table className="qt-preview-table">
                      <thead>
                        <tr>
                          {previewFields.map((f) => {
                            const role = columnRole(f.name, draftContext);
                            return (
                              <th key={f.name}>
                                <span
                                  className="qt-column-label"
                                  data-column-role={role?.kind}
                                >
                                  <ColumnRoleBadge role={role} />
                                  {f.label}
                                </span>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {groupPreview.rows.map((row, i) => (
                          <tr key={i}>
                            {previewFields.map((f) => (
                              <td
                                key={f.name}
                                className={
                                  f.name === active ? "is-focused" : ""
                                }
                              >
                                {isComputedCellError(readFieldValue(f, row)) ? (
                                  <span
                                    className="qt-formula-error"
                                    title={
                                      (
                                        readFieldValue(f, row) as {
                                          computedError: string;
                                        }
                                      ).computedError
                                    }
                                  >
                                    Error
                                  </span>
                                ) : (
                                  resolveRenderer(
                                    f,
                                    renderers,
                                  )({
                                    value: readFieldValue(f, row),
                                    row,
                                    field: f,
                                    query: api.query,
                                  })
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {"loading" in groupPreview && groupPreview.loading && <p role="status">Loading server preview…</p>}
                  {!groupPreview.rows.length && !groupPreview.error && !("loading" in groupPreview && groupPreview.loading) && (
                    <p className="qt-muted">
                      No groups match the current filters.
                    </p>
                  )}
                  <p className="qt-column-preview-note">
                    First {groupPreview.rows.length} matching groups ·{" "}
                    {"sourceTotal" in groupPreview ? groupPreview.sourceTotal ?? "…" : controller.inputs.length} source rows
                  </p>
                </>
              )}
            </>
          )}
        </section>
      </div>
      <footer className="qt-columns-footer">
        {error || formulaIssue ? (
          <span role="alert">{error || formulaIssue}</span>
        ) : (
          <span className="qt-muted">
            {discard
              ? "Discard your column changes?"
              : `${columns.length} column${columns.length === 1 ? "" : "s"}`}
          </span>
        )}
        {discard ? (
          <>
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
          </>
        ) : (
          <>
            <button type="button" className="qt-btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="qt-btn qt-btn-primary"
              disabled={
                !columns.length || columns.length > 200 || Boolean(formulaIssue)
              }
              onClick={apply}
            >
              Apply columns
            </button>
          </>
        )}
      </footer>
      {advanced && (
        <SelectColumnEditor
          api={{
            ...api,
            select: { ...api.select, visible: columns },
            setQuery: (next) => {
              const query =
                typeof next === "function"
                  ? next({ ...api.query, select: columns })
                  : next;
              setColumns(query.select);
              setActive(query.select[0]?.field ?? "");
            },
          }}
          onClose={() => setAdvanced(false)}
        />
      )}
    </EditorModal>
  );
}
