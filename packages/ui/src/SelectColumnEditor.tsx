import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import {
  computedFieldName,
  FORMULA_FUNCTIONS,
  isComputedField,
  isSelectable,
  type ColumnPreview,
  type FieldStats,
  type SelectColumn,
  type RegexInspection,
} from "@pythia-software/query-table-core";
import {
  orderPreviewGroups,
  type PreviewSort,
  type PreviewSortKey,
} from "./previewOrdering";
const FormulaEditor = lazy(() => import("./FormulaEditor"));
const fieldExpression = (name: string) => `[${name.replace(/\]/g, "]]")}]`;
const display = (v: unknown) =>
  v === null
    ? "NULL"
    : typeof v === "string"
      ? v === ""
        ? '""'
        : v
      : JSON.stringify(v);
export interface SelectColumnEditorProps<Row> {
  api: QueryTableApi<Row>;
  onClose: () => void;
}
export function SelectColumnEditor<Row>({
  api,
  onClose,
}: SelectColumnEditorProps<Row>) {
  const titleId = useId(),
    dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [columns, setColumns] = useState<SelectColumn[]>(() =>
    api.select.visible.map((c) => ({ ...c })),
  );
  const [search, setSearch] = useState(""),
    [active, setActive] = useState<string>(api.select.visible[0]?.field ?? "");
  const [editing, setEditing] = useState(false),
    [id, setId] = useState(""),
    [revision, setRevision] = useState<string | null>(null);
  const [label, setLabel] = useState(""),
    [source, setSource] = useState("");
  const [count, setCount] = useState(1000),
    [preview, setPreview] = useState<ColumnPreview | null>(null),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0),
    [retry, setRetry] = useState(0),
    [functionSearch, setFunctionSearch] = useState("");
  const [previewSort, setPreviewSort] = useState<PreviewSort | null>(null);
  const [fieldStats, setFieldStats] = useState<Record<string, FieldStats>>({});
  const drag = useRef<string | null>(null);
  const [inspection, setInspection] = useState<RegexInspection | null>(null);
  const catalogue = api.computed.catalogue.filter(isSelectable);
  const chosen = catalogue.find((f) => f.name === active);
  const expression = editing ? source : active ? fieldExpression(active) : "";
  const validation = useMemo(() => {
    if (!expression)
      return { error: "Choose a column or create a computed column." };
    try {
      return {
        plan: api.computed.compile(expression, editing ? id : undefined),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [expression, editing, id, api.computed.compile]);
  const previewPlanKey = validation.error
    ? `error:${validation.error}`
    : `plan:${JSON.stringify(validation.plan)}`;
  // Parent refreshes may recreate the API methods without changing the preview.
  // Use the latest method, but restart only when the request itself changes.
  const previewRequest = useRef(api.computed.preview);
  previewRequest.current = api.computed.preview;
  const fieldStatsRequest = useRef(api.fieldStats);
  fieldStatsRequest.current = api.fieldStats;
  const catalogueKey = JSON.stringify(catalogue.map((field) => field.name));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector(".cm-tooltip-autocomplete")) return;
        closeRef.current();
      }
      if (e.key === "Tab") {
        const focusable = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"], [contenteditable="true"]',
          ) ?? [],
        ).filter((el) => el.getClientRects().length);
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    void fieldStatsRequest
      .current(
        catalogue.map((field) => field.name),
        ac.signal,
      )
      .then((result) => {
        if (!ac.signal.aborted) setFieldStats(result);
      })
      .catch(() => {
        // Stats are an optional enhancement; catalogue browsing still works.
      });
    return () => ac.abort();
    // catalogueKey captures membership without refetching when refreshes merely
    // recreate catalogue/API objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueKey]);
  useEffect(() => {
    const ac = new AbortController();
    setPreview(null);
    setError(null);
    setPage(0);
    setInspection(null);
    if (
      validation.error ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 10000
    ) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const request = previewRequest.current;
      void request(
        expression,
        count,
        ac.signal,
        editing ? id : undefined,
        editing,
      )
        .then((result) => {
          if (!ac.signal.aborted) setPreview(result);
        })
        .catch((e) => {
          if (!ac.signal.aborted)
            setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 400);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [expression, count, editing, id, previewPlanKey, retry]);
  const move = (field: string, index: number) =>
    setColumns((cols) => {
      const next = cols.filter((c) => c.field !== field),
        item = cols.find((c) => c.field === field);
      if (item) next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
      return next;
    });
  const toggle = (field: string) =>
    setColumns((cols) =>
      cols.some((c) => c.field === field)
        ? cols.filter((c) => c.field !== field)
        : [...cols, { field }],
    );
  function browse(field: string) {
    setActive(field);
    setEditing(false);
    setNotice("");
  }
  function edit(defId?: string) {
    const def = api.computed.definitions.find((d) => d.id === defId);
    setId(def?.id ?? defId ?? crypto.randomUUID());
    setRevision(def?.revision ?? null);
    setLabel(def?.label ?? defId ?? "");
    setSource(
      def?.expression.source ??
        (defId ? "" : active ? fieldExpression(active) : "LEFT([field], 3)"),
    );
    setEditing(true);
    setNotice("");
  }
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const def = await api.computed.save(
        {
          id,
          label: label.trim(),
          expression: { language: "qt-expr", version: 1, source },
        },
        revision,
      );
      setRevision(def.revision);
      const field = computedFieldName(def.id);
      setActive(field);
      setColumns((cols) =>
        cols.some((c) => c.field === field) ? cols : [...cols, { field }],
      );
      setNotice(
        "Definition saved. All queries referencing this ID now use this definition. Apply columns to update this query’s layout.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  const groups = useMemo(
    () =>
      orderPreviewGroups(
        (preview?.groups ?? []).filter((g) =>
          filter === "errors"
            ? !!g.result.error
            : filter === "nulls"
              ? !g.result.error && g.result.value === null
              : true,
        ),
        previewSort,
      ),
    [preview, filter, previewSort],
  );
  const catalogueResults = useMemo(
    () =>
      catalogue
        .filter((f) =>
          `${f.label} ${f.name} ${f.type} ${f.group ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .map((field, index) => ({ field, index }))
        .sort((a, b) => {
          const aLow = (fieldStats[a.field.name]?.distinct ?? 2) <= 1;
          const bLow = (fieldStats[b.field.name]?.distinct ?? 2) <= 1;
          return Number(aLow) - Number(bLow) || a.index - b.index;
        })
        .map(({ field }) => field),
    [catalogue, search, fieldStats],
  );
  const shown = groups.slice(page * 50, (page + 1) * 50);
  const samePreviewSortKey = (a: PreviewSortKey, b: PreviewSortKey) => {
    if (a.kind !== b.kind) return false;
    if (a.kind === "input" && b.kind === "input")
      return a.index === b.index;
    return true;
  };
  const selectPreviewSort = (key: PreviewSortKey, direction: "asc" | "desc") => {
    setPreviewSort((current) => {
      const sameKey = !!current && samePreviewSortKey(current.key, key);
      return sameKey
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction };
    });
    setPage(0);
  };
  const previewSortDirection = (key: PreviewSortKey) =>
    previewSort && samePreviewSortKey(previewSort.key, key)
      ? previewSort.direction
      : undefined;
  const previewAriaSort = (key: PreviewSortKey) => {
    const direction = previewSortDirection(key);
    return direction === "asc"
      ? "ascending"
      : direction === "desc"
        ? "descending"
        : "none";
  };
  const previewSortHeader = (
    label: string,
    key: PreviewSortKey,
    direction: "asc" | "desc" = "asc",
  ) => {
    const currentDirection = previewSortDirection(key);
    return (
      <button
        type="button"
        className="qt-preview-sort"
        onClick={() => selectPreviewSort(key, direction)}
        title={`Sort by ${label}`}
      >
        {label}
        {currentDirection && (currentDirection === "asc" ? " ↑" : " ↓")}
      </button>
    );
  };
  return (
    <div className="qt-modal-backdrop qt-select-editor-backdrop">
      <div
        className="qt-select-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
      >
        <header className="qt-select-editor-header">
          <div>
            <h2 id={titleId}>Select columns</h2>
            <p>
              Arrange your view, explore values, and create reusable computed
              columns.
            </p>
          </div>
          <button
            type="button"
            className="qt-btn"
            onClick={onClose}
            aria-label="Close column editor"
          >
            ✕
          </button>
        </header>
        <div className="qt-select-editor-body">
          <aside className="qt-selected-panel">
            <h3>
              Selected <span className="qt-muted">{columns.length}</span>
            </h3>
            <p className="qt-muted">
              Drag to reorder, or use the arrow buttons.
            </p>
            <ol className="qt-editor-columns">
              {columns.map((c, i) => {
                const f = catalogue.find((f) => f.name === c.field);
                return (
                  <li
                    key={c.field}
                    draggable
                    onDragStart={(e) => {
                      drag.current = c.field;
                      e.dataTransfer.setData("text/plain", c.field);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag.current) move(drag.current, i);
                      drag.current = null;
                    }}
                    onDragEnd={() => {
                      drag.current = null;
                    }}
                  >
                    <span aria-hidden="true">⠿</span>
                    <button
                      type="button"
                      className="qt-column-name"
                      onClick={() => browse(c.field)}
                    >
                      {f?.label ?? c.field}
                    </button>
                    <button
                      type="button"
                      className="qt-icon-btn"
                      disabled={i === 0}
                      onClick={() => move(c.field, i - 1)}
                      aria-label={`Move ${f?.label ?? c.field} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="qt-icon-btn"
                      disabled={i === columns.length - 1}
                      onClick={() => move(c.field, i + 1)}
                      aria-label={`Move ${f?.label ?? c.field} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="qt-icon-btn"
                      onClick={() => toggle(c.field)}
                      aria-label={`Remove ${f?.label ?? c.field}`}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className="qt-link-btn"
              onClick={() =>
                setColumns(
                  api.defaults.select.length
                    ? api.defaults.select
                    : catalogue
                        .filter((f) => f.select?.default)
                        .map((f) => ({ field: f.name })),
                )
              }
            >
              Use default columns
            </button>
          </aside>
          <aside className="qt-catalogue-panel">
            <h3>Column catalogue</h3>
            <input
              className="qt-input"
              aria-label="Search columns"
              placeholder="Search name or type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="qt-btn qt-create-computed"
              onClick={() => edit()}
            >
              ＋ Computed column
            </button>
            {api.computed.loading && <p role="status">Loading definitions…</p>}
            {api.computed.error && <p role="alert">{api.computed.error}</p>}
            <div className="qt-catalogue-list">
              {catalogueResults.map((f) => {
                const distinct = fieldStats[f.name]?.distinct;
                return (
                  <div
                    className={`qt-catalogue-item ${active === f.name && !editing ? "is-active" : ""} ${distinct != null && distinct <= 1 ? "is-low-cardinality" : ""}`}
                    key={f.name}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Include ${f.label}`}
                      checked={columns.some((c) => c.field === f.name)}
                      onChange={() => toggle(f.name)}
                    />
                    <button type="button" onClick={() => browse(f.name)}>
                      <strong>{f.label}</strong>
                      <small>
                        {isComputedField(f.name) ? "ƒ · " : ""}
                        {f.type} · {f.group ?? f.name}
                        {distinct != null &&
                          ` · ${distinct.toLocaleString()} distinct`}
                      </small>
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="qt-link-btn"
              onClick={() => void api.computed.reload()}
            >
              Reload shared definitions
            </button>
          </aside>
          <section className="qt-column-workbench">
            {editing ? (
              <>
                <div className="qt-editor-title">
                  <h3>
                    {revision
                      ? "Edit shared computed column"
                      : "New computed column"}
                  </h3>
                  <span className="qt-type-badge">
                    {validation.plan?.type ?? "Check formula"}
                  </span>
                </div>
                <label className="qt-editor-label">
                  Column name
                  <input
                    className="qt-input"
                    value={label}
                    maxLength={200}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Email domain"
                  />
                </label>
                <Suspense
                  fallback={
                    <textarea
                      aria-label="Computed column formula"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    />
                  }
                >
                  <FormulaEditor
                    value={source}
                    onChange={setSource}
                    fields={api.computed.catalogue.filter(
                      (f) => f.name !== computedFieldName(id),
                    )}
                    compile={(value) => api.computed.compile(value, id)}
                  />
                </Suspense>
                <details className="qt-function-library">
                  <summary>Functions & examples</summary>
                  <input
                    className="qt-input"
                    aria-label="Search functions"
                    placeholder="Search functions…"
                    value={functionSearch}
                    onChange={(e) => setFunctionSearch(e.target.value)}
                  />
                  <div className="qt-function-list">
                    {FORMULA_FUNCTIONS.filter((f) =>
                      `${f.name} ${f.description}`
                        .toLowerCase()
                        .includes(functionSearch.toLowerCase()),
                    ).map((f) => (
                      <button
                        type="button"
                        key={f.name}
                        title={f.description}
                        onClick={() => setSource(`${f.name}(${source})`)}
                      >
                        <code>{f.signature}</code>
                        <small>{f.description}</small>
                      </button>
                    ))}
                  </div>
                  <p>
                    Examples: <code>LEFT([name], 3)</code> ·{" "}
                    <code>IF([amount] &gt; 100, "High", "Low")</code> ·{" "}
                    <code>REGEX_EXTRACT([email], "@(.+)$", 1)</code>
                  </p>
                </details>
                <div className="qt-definition-actions">
                  <button
                    type="button"
                    className="qt-btn"
                    disabled={saving || !!validation.error || !label.trim()}
                    onClick={() => void save()}
                  >
                    {saving
                      ? "Saving…"
                      : revision
                        ? "Save shared definition"
                        : "Save definition & add column"}
                  </button>
                  {revision && (
                    <button
                      type="button"
                      className="qt-link-btn"
                      onClick={() => edit(id)}
                    >
                      Reload editor from catalogue
                    </button>
                  )}
                </div>
                <p className="qt-muted">
                  Saving changes this definition across all queries. Cancel
                  below only discards column layout changes.
                </p>
              </>
            ) : (
              <div className="qt-editor-title">
                <div>
                  <h3>{chosen?.label ?? "Explore a column"}</h3>
                  <p className="qt-muted">
                    {chosen?.name} {chosen ? `· ${chosen.type}` : ""}
                  </p>
                </div>
                {chosen && isComputedField(chosen.name) && (
                  <>
                    <button
                      type="button"
                      className="qt-btn"
                      onClick={() => edit(chosen.name.slice(10))}
                    >
                      Edit definition
                    </button>
                    <button
                      type="button"
                      className="qt-btn"
                      onClick={() => {
                        const def = api.computed.definitions.find(
                          (d) => computedFieldName(d.id) === chosen.name,
                        );
                        edit();
                        if (def) {
                          setLabel(`${def.label} copy`);
                          setSource(def.expression.source);
                        }
                      }}
                    >
                      Duplicate
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="qt-preview-controls">
              <label>
                Rows to process{" "}
                <input
                  className="qt-input"
                  type="number"
                  min={1}
                  max={10000}
                  step={1}
                  value={Number.isNaN(count) ? "" : count}
                  onChange={(e) => setCount(e.target.valueAsNumber)}
                />
              </label>
              <button
                type="button"
                className="qt-btn"
                onClick={() => setRetry((n) => n + 1)}
              >
                Refresh preview
              </button>
              <label>
                Show{" "}
                <select
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">All results</option>
                  <option value="nulls">Null results</option>
                  <option value="errors">Errors</option>
                </select>
              </label>
            </div>
            <p className="qt-muted">
              First matching rows in current sort order, starting at row 1.
              Counts describe the processed sample. Maximum 10,000 rows.
            </p>
            {(!Number.isInteger(count) || count < 1 || count > 10000) && (
              <p role="alert">Choose a whole number between 1 and 10,000.</p>
            )}
            {validation.error && (
              <p className="qt-formula-error" role="alert">
                {validation.error}
              </p>
            )}
            {error && (
              <p className="qt-formula-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="qt-editor-notice" role="status">
                {notice}
              </p>
            )}
            {loading && <p role="status">Processing preview…</p>}
            {preview && (
              <>
                <p className="qt-preview-summary" role="status">
                  <strong>{preview.processed.toLocaleString()}</strong> of{" "}
                  {preview.total.toLocaleString()} matching rows ·{" "}
                  <strong>{preview.groups.length.toLocaleString()}</strong>{" "}
                  distinct combinations · {preview.nulls.toLocaleString()} null
                  · {preview.errors.toLocaleString()} errors
                  {preview.processed === preview.total
                    ? " · complete filtered set"
                    : " · sample"}
                </p>
                <div className="qt-preview-table-wrap">
                  <table className="qt-preview-table">
                    <thead>
                      <tr>
                        {editing &&
                          preview.dependencies.map((name, index) => (
                            <th
                              key={name}
                              aria-sort={previewAriaSort({
                                kind: "input",
                                index,
                              })}
                            >
                              {previewSortHeader(
                                api.computed.catalogue.find(
                                  (f) => f.name === name,
                                )?.label ?? name,
                                { kind: "input", index },
                              )}
                            </th>
                          ))}
                        <th aria-sort={previewAriaSort({ kind: "result" })}>
                          {previewSortHeader(editing ? "Result" : "Value", {
                            kind: "result",
                          })}
                        </th>
                        <th aria-sort={previewAriaSort({ kind: "count" })}>
                          {previewSortHeader("Count", { kind: "count" }, "desc")}
                        </th>
                        <th aria-sort={previewAriaSort({ kind: "percentage" })}>
                          {previewSortHeader("%", { kind: "percentage" }, "desc")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((group, i) => (
                        <tr key={i}>
                          {editing &&
                            group.inputs.map((value, j) => (
                              <td key={j} title={display(value)}>
                                {display(value)}
                              </td>
                            ))}
                          <td
                            className={
                              group.result.error ? "qt-formula-error" : ""
                            }
                            title={
                              group.result.error ?? display(group.result.value)
                            }
                          >
                            {group.result.error ?? display(group.result.value)}
                            {group.result.regex && (
                              <button
                                type="button"
                                className="qt-link-btn"
                                onClick={() =>
                                  setInspection(group.result.regex!)
                                }
                              >
                                Inspect match
                              </button>
                            )}
                          </td>
                          <td>{group.count.toLocaleString()}</td>
                          <td>
                            {((100 * group.count) / preview.processed).toFixed(
                              1,
                            )}
                            %
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {inspection && (
                  <div className="qt-regex-inspector">
                    <h4>Regex match</h4>
                    <pre>
                      {inspection.input.slice(0, inspection.start)}
                      <mark>
                        {inspection.input.slice(
                          inspection.start,
                          inspection.end,
                        )}
                      </mark>
                      {inspection.input.slice(inspection.end)}
                    </pre>
                    <dl>
                      {inspection.groups.map((value, i) => (
                        <div key={i}>
                          <dt>
                            Group {i}
                            {i === 0 ? " (whole match)" : ""}
                          </dt>
                          <dd>{display(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
                {!groups.length && <p>No matching results in this sample.</p>}
                {groups.length > 50 && (
                  <div className="qt-preview-pages">
                    <button
                      type="button"
                      className="qt-btn"
                      disabled={page === 0}
                      onClick={() => setPage((n) => n - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Combinations {page * 50 + 1}–
                      {Math.min((page + 1) * 50, groups.length)} of{" "}
                      {groups.length}
                    </span>
                    <button
                      type="button"
                      className="qt-btn"
                      disabled={(page + 1) * 50 >= groups.length}
                      onClick={() => setPage((n) => n + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        <footer className="qt-select-editor-footer">
          <span className="qt-muted">
            Computed columns are display-only. Select at least one column.
          </span>
          <button type="button" className="qt-btn" onClick={onClose}>
            Cancel layout changes
          </button>
          <button
            type="button"
            className="qt-btn qt-primary"
            disabled={!columns.length || columns.length > 200}
            onClick={() => {
              api.setQuery((q) => ({ ...q, select: columns }));
              onClose();
            }}
          >
            Apply columns
          </button>
        </footer>
      </div>
    </div>
  );
}
