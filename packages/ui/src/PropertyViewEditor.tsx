import { useEffect, useId, useState, type ReactNode } from "react";
import {
  normalizePropertyView,
  type FieldSchema,
  type PropertyFormat,
  type PropertySelection,
  type PropertyViewState,
} from "@pythia-software/query-table-core";
import type { PropertyViewApi } from "@pythia-software/query-table-react";
import { FieldPicker } from "./FieldPicker";
import { Icon, type IconName } from "./Icon";
import { ModalSurface, useMobileLayout } from "./AdaptiveOverlay";
import { EditorModal, EditorPanelSeparator, EditorPanelToggle } from "./EditorModal";
import { EditorPaneTitle } from "./EditorParts";
import { useEditorWorkbench } from "./useEditorWorkbench";
import { ReorderList } from "./ReorderList";
import { ObjectProperties, type ObjectPropertiesProps } from "./ObjectProperties";

const propertyPanes = [
  { id: "properties", label: "Properties", icon: "panelList", width: 360, minWidth: 310 },
  { id: "definition", label: "Display", icon: "panelDefinition", width: 320, minWidth: 240 },
  { id: "preview", label: "Preview", icon: "panelPreview", width: 580, minWidth: 280 },
] satisfies Array<{ id: string; label: string; icon: IconName; width: number; minWidth: number }>;

const formatChoices = [
  "auto",
  "text",
  "code",
  "json",
  "chips",
  "boolean",
  "number",
  "percent",
  "currency",
  "duration",
  "relative",
  "date",
  "time",
  "datetime",
] as const;
function chooseFormat(kind: string): PropertyFormat | undefined {
  if (kind === "auto") return;
  if (kind === "currency") return { kind, currency: "USD" };
  if (kind === "duration")
    return { kind, sourceUnit: "milliseconds", style: "human" };
  if (kind === "datetime" || kind === "date" || kind === "time")
    return { kind, timeZone: "local" };
  return { kind } as PropertyFormat;
}

export function PropertyViewEditor<Row>({
  schema,
  view,
  onApply,
  onClose,
  preview,
  scope,
}: {
  preview?: Omit<ObjectPropertiesProps<Row>, "view">;
  scope?: string;
  schema: FieldSchema<Row>;
  view: PropertyViewState;
  onApply: (view: PropertyViewState) => void;
  onClose: () => void;
}): ReactNode {
  const [draft, setDraft] = useState(() => normalizePropertyView(view));
  const [base] = useState(() => JSON.stringify(view));
  const [picker, setPicker] = useState<HTMLButtonElement | null>(null);
  const [active, setActive] = useState(draft.properties[0]?.id ?? "");
  const [pane, setPane] = useState("properties");
  const workbench = useEditorWorkbench(propertyPanes);
  const mobile = useMobileLayout();
  const panelId = useId();
  const selected = draft.properties.find((item) => item.id === active) ?? draft.properties[0];
  const dirty = base !== JSON.stringify(draft);
  const moveById = (id: string, position: number) => setDraft((previous) => {
    const properties = [...previous.properties];
    const index = properties.findIndex((item) => item.id === id);
    if (index < 0) return previous;
    properties.splice(position, 0, properties.splice(index, 1)[0]!);
    return { ...previous, properties };
  });
  const conflict = base !== JSON.stringify(view);
  let validationError = "";
  try {
    normalizePropertyView(draft);
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
  function update(
    id: string,
    patch: {
      [K in keyof PropertySelection]?: PropertySelection[K] | undefined;
    },
  ) {
    setDraft((previous) => ({
      ...previous,
      properties: previous.properties.map((property) => {
        if (property.id !== id) return property;
        const next = { ...property };
        for (const [key, value] of Object.entries(patch)) {
          const writable = next as unknown as Record<string, unknown>;
          if (value === undefined) delete writable[key];
          else writable[key] = value;
        }
        return next;
      }),
    }));
  }
  function panelToggle(index: number, collapse = false) {
    const panel = propertyPanes[index]!;
    return <EditorPanelToggle
      workbench={workbench}
      index={index}
      label={panel.label}
      icon={panel.icon}
      paneId={`${panelId}-${index}`}
      collapse={collapse}
    />;
  }
  function paneProps(index: number) {
    return {
      id: `${panelId}-${index}`,
      hidden: mobile ? pane !== propertyPanes[index]!.id : !workbench.visiblePanes[index],
    };
  }
  function separator(index: number) {
    if (mobile) return null;
    return <EditorPanelSeparator
      workbench={workbench}
      index={index}
      label={`Resize property panels ${index + 1} and ${(workbench.nextPane(index) ?? index) + 1}`}
      controls={`${panelId}-${index} ${panelId}-${workbench.nextPane(index)}`}
    />;
  }
  function editProperty(id: string) {
    setActive(id);
    setPane("definition");
    workbench.showPane(1);
  }
  return (
    <EditorModal
      title="Edit properties"
      className="qt-property-editor"
      closeLabel="Close property editor"
      onClose={onClose}
      workbench={workbench}
      panelControls={!mobile && <div className="qt-metric-panel-tools" role="group" aria-label="Visible property panels">
        <span>Panels</span>
        {propertyPanes.map((panel, index) => <span key={panel.id}>{panelToggle(index)}</span>)}
      </div>}
    >
      <div className="qt-property-editor-context">
        <span><b>{draft.properties.length}</b> selected properties</span>
        <span>Applies to every item of this type{scope ? ` · ${scope} only` : ""}</span>
      </div>
      {mobile && <div className="qt-property-editor-tabs" role="tablist" aria-label="Property editor panels">
        {propertyPanes.map(({ id, icon, label }, index) => (
          <button type="button" key={id} className="qt-btn" role="tab" aria-selected={pane === id} aria-controls={`${panelId}-${index}`} onClick={() => { setPane(id); workbench.showPane(index); }}><Icon name={icon} />{label}</button>
        ))}
      </div>}
      <div
        ref={workbench.root}
        className="qt-property-workspace"
        style={mobile ? undefined : { gridTemplateColumns: workbench.visibleIndices.map((i) => `${workbench.widths[i]}px`).join(" 6px ") }}
      >
        <aside className="qt-property-editor-library" aria-label="Selected properties" {...paneProps(0)}>
          <EditorPaneTitle actions={<>
            <button type="button" className="qt-add" disabled={draft.properties.length >= 200} aria-haspopup="dialog" aria-expanded={Boolean(picker)} onClick={(event) => setPicker(picker ? null : event.currentTarget)}><Icon name="add" />Add property</button>
            {!mobile && panelToggle(0, true)}
          </>}><Icon name="panelList" />Properties</EditorPaneTitle>
          <div className="qt-property-editor-scroll">
          <ReorderList
            className="qt-property-editor-list" showHint={false}
            items={draft.properties.map((property) => ({ id: property.id, label: property.label ?? schema.fields.find((field) => field.name === property.field)?.label ?? property.field }))}
            onMove={moveById}
            itemClassName={(item) => item.id === selected?.id ? "is-active" : ""}
            renderItem={(item, index) => (
              <>
                <button type="button" className="qt-property-pick" aria-pressed={item.id === selected?.id} onClick={() => editProperty(item.id)}>
                  <strong>{item.label}</strong><small>{draft.properties[index]?.field}</small>
                </button>
                <button type="button" className="qt-link-btn qt-property-icon-button" disabled={index === 0} aria-label={`Move ${item.label} up`} onClick={() => moveById(item.id, index - 1)}><Icon name="arrowUp" size={14} /></button>
                <button type="button" className="qt-link-btn qt-property-icon-button" disabled={index === draft.properties.length - 1} aria-label={`Move ${item.label} down`} onClick={() => moveById(item.id, index + 1)}><Icon name="arrowDown" size={14} /></button>
                <button type="button" className="qt-link-btn qt-property-icon-button" aria-label={`Remove ${item.label}`} onClick={() => setDraft((previous) => ({ ...previous, properties: previous.properties.filter((property) => property.id !== item.id) }))}><Icon name="close" size={14} /></button>
              </>
            )}
          />
          {!draft.properties.length && <p className="qt-muted">No properties selected.</p>}
          </div>
        </aside>
        {separator(0)}
        <section className="qt-property-editor-definition" aria-label="Property display settings" {...paneProps(1)}>
          <EditorPaneTitle actions={!mobile && panelToggle(1, true)}><Icon name="pencil" />Display</EditorPaneTitle>
          {selected ? (() => {
            const property = selected;
            const field = schema.fields.find((field) => field.name === property.field);
            const format = property.format;
            return <>
              <strong>{field?.label ?? property.field}</strong>
              <code className="qt-property-editor-field">{property.field} · {field?.type ?? "unavailable"}</code>
                            <div className="qt-property-editor-options">
                <label>
                  Label
                  <input
                    aria-label={`Label for ${property.id}`}
                    value={property.label ?? ""}
                    placeholder={field?.label ?? property.field}
                    maxLength={1000}
                    onChange={(event) =>
                      update(property.id, {
                        label: event.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label>
                  Display
                  <select
                    aria-label={`Display for ${property.id}`}
                    value={
                      format?.kind ?? (property.render ? "renderer" : "auto")
                    }
                    onChange={(event) =>
                      update(property.id, {
                        format: chooseFormat(event.target.value),
                        render: undefined,
                      })
                    }
                  >
                    {property.render ? (
                      <option value="renderer">
                        Custom renderer: {property.render}
                      </option>
                    ) : null}
                    {formatChoices.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind === "auto" ? "Schema default" : kind}
                      </option>
                    ))}
                  </select>
                </label>
                {format &&
                ["number", "percent", "currency", "duration"].includes(
                  format.kind,
                ) ? (
                  <label>
                    Decimals
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={(format as { decimals?: number }).decimals ?? ""}
                      onChange={(event) =>
                        update(property.id, {
                          format: {
                            ...format,
                            decimals:
                              event.target.value === ""
                                ? undefined
                                : Number(event.target.value),
                          } as PropertyFormat,
                        })
                      }
                    />
                  </label>
                ) : null}
                {format?.kind === "currency" ? (
                  <label>
                    Currency
                    <input
                      aria-label={`Currency for ${property.id}`}
                      value={format.currency}
                      maxLength={3}
                      pattern="[A-Z]{3}"
                      onChange={(event) =>
                        update(property.id, {
                          format: {
                            ...format,
                            currency: event.target.value.toUpperCase(),
                          },
                        })
                      }
                    />
                  </label>
                ) : null}
                {format &&
                ["duration", "relative", "date", "time", "datetime"].includes(
                  format.kind,
                ) ? (
                  <label>
                    Input unit
                    <select
                      aria-label={`Input unit for ${property.id}`}
                      value={
                        (format as { sourceUnit?: string }).sourceUnit ?? "iso"
                      }
                      onChange={(event) =>
                        update(property.id, {
                          format: {
                            ...format,
                            sourceUnit: event.target.value,
                          } as PropertyFormat,
                        })
                      }
                    >
                      {(format.kind === "duration"
                        ? [
                            "milliseconds",
                            "seconds",
                            "minutes",
                            "hours",
                            "days",
                          ]
                        : format.kind === "relative"
                          ? ["iso", "epochSeconds", "epochMilliseconds"]
                          : [
                              "iso",
                              "epochSeconds",
                              "epochMilliseconds",
                              ...(format.kind === "time"
                                ? ["secondsOfDay", "millisecondsOfDay"]
                                : []),
                            ]
                      ).map((unit) => (
                        <option value={unit} key={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {format &&
                ["duration", "date", "time", "datetime"].includes(
                  format.kind,
                ) ? (
                  <label>
                    Style
                    <select
                      value={(format as { style?: string }).style ?? "human"}
                      onChange={(event) =>
                        update(property.id, {
                          format: {
                            ...format,
                            style: event.target.value,
                          } as PropertyFormat,
                        })
                      }
                    >
                      {(format.kind === "duration"
                        ? ["human", "long", "clock", "custom"]
                        : ["human", "iso", "custom"]
                      ).map((style) => (
                        <option key={style} value={style}>
                          {style}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {format && "style" in format && format.style === "custom" ? (
                  <label>
                    Pattern
                    <input
                      value={format.pattern ?? ""}
                      onChange={(event) =>
                        update(property.id, {
                          format: { ...format, pattern: event.target.value },
                        })
                      }
                    />
                  </label>
                ) : null}
                {format &&
                ["date", "time", "datetime"].includes(format.kind) ? (
                  <label>
                    Time zone
                    <input
                      value={
                        (format as { timeZone?: string }).timeZone ?? "local"
                      }
                      placeholder="local, UTC, America/Denver"
                      onChange={(event) =>
                        update(property.id, {
                          format: {
                            ...format,
                            timeZone: event.target.value,
                          } as PropertyFormat,
                        })
                      }
                    />
                  </label>
                ) : null}
              </div>
            </>;
          })() : <p className="qt-muted">Add a property to configure its display.</p>}
        </section>
        {separator(1)}
        <section className="qt-property-editor-preview" aria-label="Live property preview" {...paneProps(2)}>
          <EditorPaneTitle actions={!mobile && panelToggle(2, true)}><Icon name="panelPreview" />Live preview</EditorPaneTitle>
          <p className="qt-muted">Changes stay in this draft until applied.</p>
          {preview ? <div className="qt-object-inspector"><ObjectProperties {...preview} schema={schema} view={draft} onViewChange={setDraft} /></div> : <p className="qt-muted">Open an item to preview its values.</p>}
        </section>
      </div>
      {conflict && <p role="alert" className="qt-property-error">The view changed while editing. Cancel and reopen to use the current view.</p>}
      {validationError && <p role="alert" className="qt-property-error">{validationError}</p>}
      <footer className="qt-property-editor-footer">
        <span className="qt-muted">{dirty ? "Unsaved changes" : "Choose, order, and format properties."}</span>
        <button type="button" className="qt-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="qt-btn qt-btn-primary" disabled={conflict || Boolean(validationError)} onClick={() => { onApply(normalizePropertyView(draft)); onClose(); }}><Icon name="check" />Apply properties</button>
      </footer>
      {picker && <FieldPicker
        anchor={picker}
        fields={schema.fields.filter((field) => field.property?.enabled !== false)}
        onPick={(field) => {
          let index = draft.properties.length;
          while (draft.properties.some((property) => property.id === `property-${index}`)) index++;
          const id = `property-${index}`;
          setDraft((previous) => ({ ...previous, properties: [...previous.properties, { id, field: field.name }] }));
          setPicker(null); editProperty(id);
        }}
        onClose={() => setPicker(null)}
      />}
    </EditorModal>
  );
}

export function PropertyViewControls<Row>({
  api,
  schema,
  preview,
  scope,
  shareAction,
  onClose,
  closeLabel = "Close item details",
  compact = false,
}: {
  onClose?: () => void;
  closeLabel?: string;
  compact?: boolean;
  shareAction?: ReactNode;
  preview?: Omit<ObjectPropertiesProps<Row>, "view">;
  scope?: string;
  api: PropertyViewApi;
  schema: FieldSchema<Row>;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editorId = useId();
  const saveId = useId();
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setManaging(false);
    setError("");
  }, [schema.name]);
  const active = api.saved.find(
    (item) => JSON.stringify(item.view) === JSON.stringify(api.view),
  );
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const disabled = api.loading || busy;
  return (
    <div className="qt-property-controls">
      <div className="qt-property-toolbar" role="group" aria-label="Property views">
        <div className="qt-property-view-state">
          <button
            type="button"
            className={`qt-link-btn qt-property-save-star${active ? " qt-property-save-star--saved" : ""}`}
            aria-label="Save view"
            title="Save property view"
            aria-expanded={saving}
            aria-controls={saveId}
            disabled={disabled}
            onClick={() => { setSaving(!saving); setEditing(false); }}
          >
            <Icon name="star" filled={Boolean(active)} />
          </button>
          <label className="qt-property-view-picker">
            <span className="qt-sr-only">View</span>
            <select
              aria-label="Saved property view"
              value={active?.id ?? ""}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value) api.load(event.target.value);
                setEditing(false);
                setSaving(false);
              }}
            >
              <option value="" disabled>Custom view</option>
              {api.saved.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.id === api.defaultId ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="qt-property-toolbar-actions">
          <button
            type="button"
            className={`${compact ? "qt-link-btn qt-property-icon-button" : "qt-btn"}${editing ? " qt-btn--active" : ""}`}
            aria-label="Customize properties"
            title="Customize properties"
            aria-haspopup="dialog"
            aria-expanded={editing}
            aria-controls={editorId}
            disabled={disabled}
            onClick={() => { setEditing(!editing); setSaving(false); }}
          >
            <Icon name="pencil" size={14} /><span className={compact ? "qt-sr-only" : undefined}>Properties</span>
          </button>
          <button type="button" className={compact ? "qt-link-btn qt-property-icon-button" : "qt-btn"} title="Saved property views" disabled={disabled} onClick={() => setManaging(true)}>
            <Icon name="bookmark" size={14} /><span className={compact ? "qt-sr-only" : undefined}>Saved{api.saved.length ? ` (${api.saved.length})` : ""}</span>
          </button>
          {shareAction}
          <div className="qt-property-history" role="group" aria-label={onClose ? "View history and close" : "View history"}>
            <button type="button" className="qt-link-btn qt-property-icon-button" aria-label="Undo" title="Undo property view change" disabled={!api.canUndo || disabled} onClick={api.undo}>
              <Icon name="undo" size={14} />
            </button>
            <button type="button" className="qt-link-btn qt-property-icon-button" aria-label="Redo" title="Redo property view change" disabled={!api.canRedo || disabled} onClick={api.redo}>
              <Icon name="redo" size={14} />
            </button>
            <button type="button" className="qt-link-btn qt-property-icon-button" aria-label="Reset properties" title="Reset properties" disabled={disabled} onClick={() => { api.reset(); setEditing(false); }}>
              <Icon name="reset" size={14} />
            </button>
            {onClose && <span className="qt-property-close-divider" aria-hidden="true" />}
            {onClose && <button type="button" className="qt-link-btn qt-property-icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
              <Icon name="close" size={14} />
            </button>}
          </div>
        </div>
      </div>
      {saving ? (
        <form
          id={saveId}
          className="qt-property-save"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSaving(false); } }}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !name.trim()) return;
            void run(async () => {
              await api.save(name);
              setSaving(false);
              setName("");
            });
          }}
        >
          <label>
            View name
            <input aria-label="Property view name" autoFocus required maxLength={200} value={name} disabled={disabled} placeholder="e.g. Execution details" onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="submit" className="qt-btn qt-btn--primary" disabled={disabled || !name.trim()}><Icon name="check" size={14} />Save</button>
          <button type="button" className="qt-btn" disabled={busy} onClick={() => setSaving(false)}>Cancel</button>
        </form>
      ) : null}
      {!managing && (error || api.error) ? <p className="qt-property-error" role="alert">{error || api.error?.message}</p> : null}
      {editing ? (
        <div id={editorId}>
          <PropertyViewEditor {...(scope ? { scope } : {})} schema={schema} view={api.view} onApply={api.setView} onClose={() => setEditing(false)} {...(preview ? { preview } : {})} />
        </div>
      ) : null}
      {managing ? (
        <ModalSurface title="Saved property views" onClose={() => setManaging(false)} className="qt-modal qt-property-saved-modal">
          <div className="qt-overlay-body">
            <p className="qt-muted">Saved views apply to every item of this type.</p>
            {api.saved.length === 0 ? <p className="qt-muted">No saved views yet. Use the star to save this view.</p> : (
              <ul className="qt-saved-list">
                {api.saved.map((item) => (
                  <li className="qt-saved-item" key={item.id}>
                    <button type="button" className="qt-saved-pick" disabled={disabled} onClick={() => { api.load(item.id); setEditing(false); setSaving(false); setManaging(false); }}>
                      <span className="qt-saved-name">{item.name}</span>
                      <span className="qt-saved-meta qt-muted">{item.id === api.defaultId ? "Default view · " : ""}{item.view.properties.length} properties</span>
                    </button>
                    <button type="button" className={`qt-btn${item.id === api.defaultId ? " qt-btn--active" : ""}`} disabled={disabled} title={item.id === api.defaultId ? "Clear default" : "Use as default"} onClick={() => void run(() => api.setDefault(item.id === api.defaultId ? null : item.id))}>
                      <Icon name="check" size={14} />{item.id === api.defaultId ? "Clear default" : "Use as default"}
                    </button>
                    <button type="button" className="qt-link-btn qt-property-icon-button" aria-label={`Delete view ${item.name}`} title={`Delete view ${item.name}`} disabled={disabled} onClick={() => void run(() => api.remove(item.id))}><Icon name="close" size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
            {error || api.error ? <p className="qt-property-error" role="alert">{error || api.error?.message}</p> : null}
          </div>
        </ModalSurface>
      ) : null}
    </div>
  );
}
