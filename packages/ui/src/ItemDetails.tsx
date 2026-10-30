import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { encodeQuery, renderItemPageTemplate, type ItemDetailMode, type ItemPropertyMode, type QueryState, type RowId } from "@pythia-software/query-table-core";
import type { ItemDetailRecord, ItemDetailsApi } from "@pythia-software/query-table-react";
import type { RenderRegistry } from "./renderers";
import { ObjectInspector } from "./ObjectInspector";
import { Icon, type IconName } from "./Icon";
import { ModalSurface } from "./AdaptiveOverlay";
import { ShareButton } from "./ShareButton";

export const ITEM_DETAIL_MODES: Array<{ mode: ItemDetailMode; label: string; description: string; icon: IconName }> = [
  { mode: "hover", label: "Popover", description: "Click to preview properties until you dismiss the card.", icon: "itemHover" },
  { mode: "modal", label: "Modal", description: "Open an item in a shareable details dialog.", icon: "itemModal" },
  { mode: "expand", label: "Row expand", description: "Show properties underneath a row.", icon: "itemExpand" },
  { mode: "page", label: "Page", description: "Follow a configurable link to the item's page.", icon: "externalLink" },
];

/** Used inside the column selector's transactional draft. */
export function ItemDetailChoices({ available, modes, onChange }: {
  available: ItemDetailMode[]; modes: ItemDetailMode[]; onChange: (modes: ItemDetailMode[]) => void;
}): ReactNode {
  return <fieldset className="qt-item-detail-choices">
    <legend>Detail</legend>
    <p className="qt-muted">Add detail buttons to every row.</p>
    {ITEM_DETAIL_MODES.filter((item) => available.includes(item.mode)).map(({ mode, label, description, icon }) => (
      <label key={mode}>
        <input type="checkbox" aria-label={`Include ${label}`} checked={modes.includes(mode)} onChange={() => onChange(modes.includes(mode) ? modes.filter((item) => item !== mode) : [...modes, mode])} />
        <Icon name={icon} /><span><strong>{label}</strong><small>{description}</small></span>
      </label>
    ))}
  </fieldset>;
}

function DetailContent<Row>({ api, record, loading, error, onRetry, renderers, mode, query, id, onClose }: {
  api: ItemDetailsApi<Row>; record: ItemDetailRecord<Row> | null; loading: boolean; error: Error | null; onRetry: () => void;
  renderers: RenderRegistry<Row>; mode: ItemPropertyMode; query: QueryState; id: RowId; onClose: () => void;
}): ReactNode {
  const compact = mode === "hover";
  const noun = api.subject === "group" ? "group" : "item";
  const closeLabel = mode === "hover" ? `Close ${noun} preview` : mode === "expand" ? `Collapse ${noun} ${id}` : `Close ${noun} details`;
  const actions = <>
    <ItemDetailShare api={api} query={query} id={id} mode={mode} compact={compact} />
    {mode !== "modal" && api.modes.includes("modal") && <button type="button" className="qt-link-btn qt-property-icon-button" aria-label="Open in modal" title="Open in modal" onClick={() => { onClose(); api.open(id, "modal"); }}><Icon name="itemModal" size={14} /></button>}
  </>;
  if (!record) return <section className="qt-object-inspector qt-item-detail-fallback" aria-label={`${noun === "group" ? "Group" : "Item"} details status`}>
    <div className="qt-property-toolbar">
      <code>{String(id)}</code>
      <div className="qt-property-toolbar-actions">
        {actions}<span className="qt-property-close-divider" aria-hidden="true" />
        <button type="button" className="qt-link-btn qt-property-icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
    </div>
    <DetailStatus loading={loading} error={error} onRetry={onRetry} group={noun === "group"} />
  </section>;
  return <ObjectInspector schema={api.schema} row={record.row} recordId={id}
    {...(api.jsonInspections ? { jsonInspections: api.jsonInspections } : {})}
    {...(api.setJsonInspection ? { onJsonInspectionChange: api.setJsonInspection } : {})} attention={api.attention} preserveFocus={api.preserveFocus} {...(api.subject === "group" ? { query } : {})} propertyApi={api.propertiesByMode[mode]} viewScope={mode === "hover" ? "Popover" : mode === "expand" ? "Row expand" : "Modal"} renderers={renderers}
    shareAction={actions} onClose={onClose} closeLabel={closeLabel} compact={compact}
    {...(record.loadedFields ? { loadedFields: record.loadedFields } : {})}
    {...(api.relationships ? { relationships: api.relationships } : {})} />;
}
function DetailStatus({ loading, error, onRetry, group = false }: { loading: boolean; error: Error | null; onRetry: () => void; group?: boolean }): ReactNode {
  return <div className="qt-item-detail-status">
    {loading ? <p role="status">{group ? "Loading group…" : "Loading item…"}</p> : error ? <><p role="alert">{error.message}</p><button type="button" className="qt-btn" onClick={onRetry}><Icon name="refresh" />Retry</button></>
      : <p role="status">{group ? "This group is unavailable. It is not in the grouped results loaded since they last changed or refreshed; it may be gone or on another page." : "This item is unavailable. It may have been removed or is outside the loaded results."}</p>}
  </div>;
}
/** Snapshot the item and collection state, even when URL synchronization is off.
 * A popover is shared as a modal with that popover's current appearance. */
export function itemDetailHref<Row>(api: ItemDetailsApi<Row>, query: QueryState, id: RowId, mode: ItemPropertyMode = "modal"): string {
  const sharedQuery = itemDetailQuery(api, query, id, mode);
  if (api.links) return api.links.local(sharedQuery, window.location.href, api.queryParameter).url;
  return inlineItemDetailHref(api, sharedQuery);
}
function inlineItemDetailHref<Row>(api: ItemDetailsApi<Row>, sharedQuery: QueryState, baseUrl = window.location.href): string {
  const url = new URL(baseUrl);
  url.searchParams.set(api.queryParameter, encodeQuery(sharedQuery));
  return url.toString();
}
function itemDetailQuery<Row>(api: ItemDetailsApi<Row>, query: QueryState, id: RowId, mode: ItemPropertyMode): QueryState {
  const sharedMode = mode === "hover" ? "modal" : mode;
  const modes = api.modes.includes(sharedMode) ? api.modes : [...api.modes, sharedMode];
  return { ...query, itemDetails: {
    ...query.itemDetails, modes, page: api.page,
    views: { hover: api.propertiesByMode.hover.view,
      modal: mode === "hover" ? api.propertiesByMode.hover.view : api.propertiesByMode.modal.view,
      expand: api.propertiesByMode.expand.view }, active: { id, mode: sharedMode },
  } };
}
export function ItemDetailShare<Row>({ api, query, id, mode = "modal", compact = false }: { api: ItemDetailsApi<Row>; query: QueryState; id: RowId; mode?: ItemPropertyMode; compact?: boolean }): ReactNode {
  return <ShareButton getUrl={async () => api.links
    ? (await api.links.create(itemDetailQuery(api, query, id, mode), { parameter: api.queryParameter })).url
    : itemDetailHref(api, query, id, mode)} compact={compact} />;
}
export function ItemDetailsPanel<Row>({ api, query, renderers, outsidePage = false }: {
  api: ItemDetailsApi<Row>; query: QueryState; renderers: RenderRegistry<Row>; outsidePage?: boolean;
}): ReactNode {
  if (!api.active) return null;
  const { id, mode } = api.active;
  const content = <DetailContent api={api} record={api.record} loading={api.loading} error={api.error} onRetry={api.retry} renderers={renderers} mode={mode} query={query} id={id} onClose={api.close} />;
  if (mode === "modal") return <ModalSurface title={api.subject === "group" ? "Group details" : "Item details"} className="qt-modal qt-item-detail-modal" preserveFocus={api.preserveFocus} chrome={false} onClose={api.close}>{content}</ModalSurface>;
  const noun = api.subject === "group" ? "group" : "item";
  return <section className="qt-item-expanded" aria-label={`Expanded ${noun} ${id}`}>
    {outsidePage && <p className="qt-item-detail-note">Expanded {noun} is outside the current page.</p>}
    {content}
  </section>;
}

export function ItemDetailsActions<Row>({ api, query, id, row, renderers, expandedId, label = `item ${id ?? ""}` }: {
  api: ItemDetailsApi<Row>; query: QueryState; id: RowId | null; row: Row; renderers: RenderRegistry<Row>; expandedId: string;
  /** Names the row in button labels, such as "item 42" or "group claude / opus". */
  label?: string;
}): ReactNode {
  const [hover, setHover] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const modesKey = api.modes.join(",");
  const baseUrl = typeof window !== "undefined" ? window.location.href : "";
  const pageLink = useMemo(() => {
    let href: string | null = null;
    let error: string | null = null;
    let lazy = false;
    try {
      if (api.modes.includes("page")) href = api.page.urlTemplate.trim()
        ? renderItemPageTemplate(api.page.urlTemplate, api.pageSchema, row, id, encodeQuery(query))
        : id != null && baseUrl ? inlineItemDetailHref(api, itemDetailQuery(api, query, id, "modal"), baseUrl) : null;
      if (href && new TextEncoder().encode(href).length > (api.links?.maxUrlBytes ?? 2000)) {
        href = null;
        if (!api.page.urlTemplate.trim() && api.links) lazy = true;
        else error = "Page URL exceeds the inline link budget. Use an item Share link or a host page that resolves query codes.";
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    return { href, error, lazy };
  }, [query, row, id, baseUrl, modesKey, api.queryParameter, api.page.urlTemplate, api.page.target, api.pageSchema,
    api.links?.maxUrlBytes, api.propertiesByMode.hover.view, api.propertiesByMode.modal.view, api.propertiesByMode.expand.view]);
  function followPage(newTab = false) {
    try {
      // Only an activated oversized link writes to the FIFO cache. Rendering
      // a page of rows must not evict the live collection's address-bar code.
      const href = itemDetailHref(api, query, id!);
      setNavigationError(null);
      if (newTab || api.page.target === "_blank") window.open(href, "_blank", "noopener,noreferrer");
      else window.location.assign(href);
    } catch (e) { setNavigationError(e instanceof Error ? e.message : String(e)); }
  }
  const pageHref = pageLink.href;
  return <div className="qt-item-detail-actions">
    {api.modes.includes("hover") && <button ref={button} type="button" className="qt-link-btn qt-item-detail-button" aria-label={`Preview ${label}`} title="Open popover" disabled={id == null}
      aria-haspopup="dialog" aria-expanded={hover}
      onClick={() => setHover(open => !open)}><Icon name="itemHover" /></button>}
    {api.modes.includes("modal") && <button type="button" className="qt-link-btn qt-item-detail-button" aria-label={`Open ${label} in modal`} title="Open in modal" disabled={id == null} aria-haspopup="dialog" onClick={() => { setHover(false); if (id != null) api.open(id, "modal"); }}><Icon name="itemModal" /></button>}
    {api.modes.includes("expand") && <button type="button" className="qt-link-btn qt-item-detail-button" aria-label={`Expand ${label}`} title="Expand row" disabled={id == null}
      aria-expanded={api.active?.mode === "expand" && api.active.id === id} aria-controls={expandedId}
      onClick={() => { setHover(false); if (id != null) { if (api.active?.mode === "expand" && api.active.id === id) api.close(); else api.open(id, "expand"); } }}><Icon name={api.active?.mode === "expand" && api.active.id === id ? "chevronDown" : "itemExpand"} /></button>}
    {api.modes.includes("page") && (pageHref
      ? <a className="qt-link-btn qt-item-detail-button" href={pageHref} target={api.page.target} rel={api.page.target === "_blank" ? "noopener noreferrer" : undefined}
        aria-label={`Open ${label} on page`} title={api.page.target === "_blank" ? "Open page in new tab" : "Open page"}><Icon name="externalLink" /></a>
      : <button type="button" className="qt-link-btn qt-item-detail-button" disabled={!pageLink.lazy}
        onClick={event => followPage(event.metaKey || event.ctrlKey)}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); followPage(true); } }}
        aria-label={`Open ${label} on page`} title={pageLink.lazy ? "Open page" : pageLink.error ?? "Page URL unavailable. Check the template and row values."}><Icon name="externalLink" /></button>)}
    {navigationError && <small role="alert">{navigationError}</small>}
    {hover && api.modes.includes("hover") && id != null && <ItemHoverCard api={api} query={query} id={id} renderers={renderers} anchor={button.current}
      onClose={() => { setHover(false); button.current?.focus(); }} />}
  </div>;
}
function ItemHoverCard<Row>({ api, query, id, renderers, anchor, onClose }: {
  api: ItemDetailsApi<Row>; query: QueryState; id: RowId; renderers: RenderRegistry<Row>; anchor: HTMLElement | null;
  onClose: () => void;
}): ReactNode {
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const [result, setResult] = useState<{ record: ItemDetailRecord<Row> | null; loading: boolean; error: Error | null }>({ record: null, loading: true, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ record: null, loading: true, error: null });
    void api.loadRow(id, controller.signal).then((record) => {
      if (!controller.signal.aborted) setResult({ record, loading: false, error: null });
    }).catch((error) => {
      if (!controller.signal.aborted) setResult({ record: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
    });
    return () => controller.abort();
  }, [id, api.loadRow, retry]);
  useEffect(() => {
    if (!anchor) return;
    const styles = getComputedStyle(anchor);
    const theme: Record<string, string> = { fontFamily: styles.fontFamily };
    for (const property of Array.from(styles)) if (property.startsWith("--qt-")) theme[property] = styles.getPropertyValue(property);
    const positionCard = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(480, window.innerWidth - 24);
      const maxHeight = Math.min(560, window.innerHeight - 24);
      const height = Math.min(popup.current?.offsetHeight || maxHeight, maxHeight);
      const below = rect.bottom + 8;
      const belowSpace = window.innerHeight - below - 12;
      const aboveSpace = rect.top - 20;
      const top = height <= belowSpace || belowSpace >= aboveSpace ? below : rect.top - height - 8;
      setPosition({ ...theme, width, maxHeight,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(top, window.innerHeight - height - 12)),
      });
    };
    positionCard();
    const resize = new ResizeObserver(positionCard);
    if (popup.current) resize.observe(popup.current);
    const dismiss = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !anchor.contains(event.target as Node) && !document.querySelector(".qt-property-editor, .qt-property-saved-modal, .qt-json-inspector")) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(".qt-property-editor, .qt-property-saved-modal, .qt-json-inspector")) { event.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", positionCard);
    window.addEventListener("scroll", positionCard, true);
    return () => { resize.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); window.removeEventListener("resize", positionCard); window.removeEventListener("scroll", positionCard, true); };
  }, [anchor, onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(<div ref={popup} className="qt-item-hover-card" role="dialog" aria-label="Item preview" style={position}>
    <DetailContent api={api} record={result.record} loading={result.loading} error={result.error} onRetry={() => setRetry((value) => value + 1)} renderers={renderers} mode="hover" query={query} id={id} onClose={onClose} />
  </div>, document.body);
}
