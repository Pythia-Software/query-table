import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FieldSchema, ItemDetailMode, ItemPropertyMode, ItemPageOptions, ItemDetailsState, PropertyViewStorage,
  QueryState, RelationshipAdapter, RowId, Transport, PropertyViewState, ScopedJsonInspectionState, AttentionRegistry, AttentionProvider,
} from "@pythia-software/query-table-core";
import { isPropertyFieldLoaded, jsonInspectionScopeKey, MAX_JSON_INSPECTIONS } from "@pythia-software/query-table-core";
import { usePropertyView, type PropertyViewApi } from "./usePropertyView";
import type { QueryLinksApi } from "./useQueryLinks";

export interface ItemDetailRecord<Row> {
  row: Row;
  /** Omit for complete records. Supply for a projection to distinguish missing values from NULL. */
  loadedFields?: readonly string[];
}
export interface ItemDetailsOptions<Row> {
  /** Detail catalogue; defaults to the table catalogue. Useful for non-column properties. */
  schema?: FieldSchema<Row>;
  /** Optional semantic reveal service, shared with host attention navigation. */
  attention?: AttentionRegistry;
  /** Legacy collection URL parameter. useQueryTable.queryParameter takes precedence. */
  queryParameter?: string;
  /** Creator-approved modalities; users can enable/disable these in Select columns. Defaults to all. */
  modes?: ItemDetailMode[];
  /** Initially selected buttons. Defaults to Modal (or the first allowed mode). */
  defaultModes?: ItemDetailMode[];
  /** Creator's initial Page link settings; users can override in the column editor. */
  page?: ItemPageOptions;
  storage?: PropertyViewStorage;
  objectType?: string;
  relationships?: RelationshipAdapter;
  /** Defaults to complete clientRows or Transport.fetchRow, then the current projected row. */
  loadRow?: (id: RowId, signal: AbortSignal) => Promise<ItemDetailRecord<Row> | null>;
}
export interface ItemDetailsApi<Row> {
  /** "group" details describe grouped result rows, identified by their group identity. */
  subject?: "item" | "group";
  links?: QueryLinksApi;
  jsonInspections?: readonly ScopedJsonInspectionState[];
  setJsonInspection?: (inspection: ScopedJsonInspectionState) => void;
  attention?: AttentionRegistry;
  preserveFocus?: boolean;
  /** Ephemeral request counter; virtual tables rematerialize an expanded row per reveal. */
  attentionRevision?: number;
  /** Keep the requested virtual detail materialized until its reveal settles. */
  attentionPending?: boolean;
  schema: FieldSchema<Row>;
  /** Collection catalogue used to resolve Page template fields. */
  pageSchema: FieldSchema<Row>;
  queryParameter: string;
  /** Modal controller, retained for standalone cards. */
  properties: PropertyViewApi;
  propertiesByMode: Record<ItemPropertyMode, PropertyViewApi>;
  page: ItemPageOptions;
  availableModes: ItemDetailMode[];
  modes: ItemDetailMode[];
  active: ItemDetailsState["active"] | null;
  record: ItemDetailRecord<Row> | null;
  loading: boolean;
  error: Error | null;
  relationships?: RelationshipAdapter;
  setModes(modes: ItemDetailMode[]): void;
  open(id: RowId, mode: "modal" | "expand"): void;
  close(): void;
  retry(): void;
  loadRow(id: RowId, signal: AbortSignal): Promise<ItemDetailRecord<Row> | null>;
}
const ALL_MODES: ItemDetailMode[] = ["hover", "modal", "expand", "page"];
export function initialDetailModes<Row>(config: ItemDetailsOptions<Row> | undefined): ItemDetailMode[] {
  const available = ALL_MODES.filter(mode => !config?.modes || config.modes.includes(mode));
  return config?.defaultModes ? available.filter(mode => config.defaultModes!.includes(mode))
    : available.includes("modal") ? ["modal"] : available.slice(0, 1);
}

/** Synchronize a single modality without overwriting its siblings. */
function useDetailProperties<Row>(mode: ItemPropertyMode, schema: FieldSchema<Row>, config: ItemDetailsOptions<Row> | undefined,
  query: QueryState, setQuery: (next: QueryState | ((previous: QueryState) => QueryState)) => void, enabled: boolean,
  readOnly = false): PropertyViewApi {
  const snapshot = query.itemDetails?.views?.[mode] ?? query.itemDetails?.view;
  const seed = useRef(snapshot);
  const properties = usePropertyView({ schema,
    ...(config?.storage ? { storage: config.storage } : {}),
    key: `${config?.objectType ?? schema.name}:${mode}`,
    ...(seed.current ? { initialView: seed.current } : {}),
  });
  const queryViewKey = JSON.stringify(snapshot);
  const localViewKey = JSON.stringify(properties.view);
  const previousView = useRef({ query: queryViewKey, local: localViewKey });
  const baselineView = useRef(properties.view);
  const baselineReady = useRef(false);
  const pendingView = useRef<{ query: string | undefined; local: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!properties.loading && !baselineReady.current) {
      baselineView.current = properties.view;
      baselineReady.current = true;
    }
    const previous = previousView.current;
    previousView.current = { query: queryViewKey, local: localViewKey };
    if (queryViewKey !== previous.query) {
      const next = snapshot ?? baselineView.current;
      const target = JSON.stringify(next);
      pendingView.current = target !== localViewKey ? { query: queryViewKey, local: target } : null;
      if (target !== localViewKey) properties.setView(next);
    } else if (pendingView.current && pendingView.current.query === queryViewKey) {
      if (pendingView.current.local === localViewKey) pendingView.current = null;
    } else if (!readOnly && !properties.loading && localViewKey !== queryViewKey && (queryViewKey !== undefined || localViewKey !== previous.local)) {
      setQuery((current) => ({ ...current, itemDetails: {
        modes: current.itemDetails?.modes ?? initialDetailModes(config),
        ...current.itemDetails,
        views: { ...current.itemDetails?.views, [mode]: properties.view },
      } }));
    }
  }, [enabled, queryViewKey, localViewKey, properties.loading, properties.setView, setQuery]);
  return properties;
}

/** Independent, type-level property controllers for each detail modality. */
export function useItemDetails<Row>({
  schema, query, setQuery, options, rows, clientRows, rowId, transport, refreshKey, links, queryReady = true, queryParameter, lookupRow, subject,
}: {
  schema: FieldSchema<Row>;
  query: QueryState;
  setQuery: (next: QueryState | ((previous: QueryState) => QueryState)) => void;
  options: boolean | ItemDetailsOptions<Row> | undefined;
  rows: Row[];
  clientRows: Row[] | undefined;
  rowId: (row: Row) => RowId | null;
  transport: Transport<Row> | undefined;
  refreshKey: number;
  links?: QueryLinksApi;
  queryParameter?: string;
  /** Hold property-view synchronization while the collection query is restoring. */
  queryReady?: boolean;
  /** Resolves records synchronously from rows already held, without loading
   * by ID; `undefined` means still loading and `null` unavailable. */
  lookupRow?: (id: RowId) => ItemDetailRecord<Row> | null | undefined;
  subject?: "item" | "group";
}): ItemDetailsApi<Row> | undefined {
  const enabled = Boolean(options);
  const config = typeof options === "object" ? options : undefined;
  const detailSchema = config?.schema ?? schema;
  const availableModes = ALL_MODES.filter((mode) => !config?.modes || config.modes.includes(mode));
  const modes = availableModes.filter((mode) => (query.itemDetails?.modes ?? initialDetailModes(config)).includes(mode));
  const page = query.itemDetails?.page ?? config?.page ?? { urlTemplate: "", target: "_blank" as const };
  const requested = query.itemDetails?.active;
  const sharedModal = requested?.mode === "modal" && query.itemDetails?.modes.includes("modal")
    && (availableModes.includes("hover") || (availableModes.includes("page") && !page.urlTemplate.trim()));
  const active = requested && (modes.includes(requested.mode) || sharedModal) ? requested : null;
  // Property storage can hydrate independently, but must not apply its view to
  // a placeholder query and thereby cancel a pending URL/saved-query restore.
  const syncProperties = enabled && queryReady;
  // A group schema changes with every summary edit. Group views reach the
  // query when a group is opened or shared, never as a side effect of one.
  const readOnly = subject === "group";
  const modalProperties = useDetailProperties("modal", detailSchema, config, query, setQuery, syncProperties, readOnly);
  const hoverProperties = useDetailProperties("hover", detailSchema, config, query, setQuery, syncProperties, readOnly);
  const expandProperties = useDetailProperties("expand", detailSchema, config, query, setQuery, syncProperties, readOnly);
  const propertiesByMode = { modal: modalProperties, hover: hoverProperties, expand: expandProperties };
  const views: Record<ItemPropertyMode, PropertyViewState> = {
    modal: modalProperties.view, hover: hoverProperties.view, expand: expandProperties.view,
  };

  const customLoad = config?.loadRow;
  const customLoadRef = useRef(customLoad);
  customLoadRef.current = customLoad;
  const lookupRef = useRef(lookupRow);
  lookupRef.current = lookupRow;
  const hasLookup = Boolean(lookupRow);
  // Inline host callbacks should not restart a request on every controller
  // render. Data-source/type changes and explicit refresh/retry still reload.
  const hasCustomLoad = Boolean(customLoad);
  const sourceType = config?.objectType ?? detailSchema.name;
  const fallbackRows = !customLoad && !clientRows && !transport?.fetchRow ? rows : undefined;
  const loadRow = useCallback(async (id: RowId, signal: AbortSignal): Promise<ItemDetailRecord<Row> | null> => {
    if (lookupRef.current) return lookupRef.current(id) ?? null;
    if (customLoadRef.current) return customLoadRef.current(id, signal);
    if (clientRows) {
      const row = clientRows.find((row) => rowId(row) === id);
      return row ? { row } : null;
    }
    if (transport?.fetchRow) {
      const row = await transport.fetchRow(id, signal);
      return row ? { row } : null;
    }
    const row = rows.find((row) => rowId(row) === id);
    return row ? { row, loadedFields: Object.keys(row as object) } : null;
  }, [hasLookup, hasCustomLoad, sourceType, clientRows, transport?.fetchRow, fallbackRows, rowId]);
  const [retryKey, setRetryKey] = useState(0);
  const [result, setResult] = useState<{
    source: typeof loadRow | undefined; epoch: string; id: RowId | undefined; record: ItemDetailRecord<Row> | null; loading: boolean; error: Error | null;
  }>({ source: undefined, epoch: "", id: undefined, record: null, loading: false, error: null });
  const activeId = enabled && !lookupRow ? active?.id : undefined;
  const epoch = `${refreshKey}:${retryKey}`;
  const currentResult = result.id === activeId && result.source === loadRow && result.epoch === epoch;
  useEffect(() => {
    const controller = new AbortController();
    if (activeId === undefined) {
      setResult((previous) => previous.id === undefined && !previous.loading && !previous.error && !previous.record ? previous : { source: undefined, epoch: "", id: undefined, record: null, loading: false, error: null });
      return;
    }
    setResult(previous => ({ source: loadRow, epoch, id: activeId, record: previous.id === activeId && previous.source === loadRow ? previous.record : null, loading: true, error: null }));
    void Promise.resolve().then(() => loadRow(activeId, controller.signal)).then((record) => {
      if (!controller.signal.aborted) setResult({ source: loadRow, epoch, id: activeId, record, loading: false, error: null });
    }).catch((error) => {
      if (!controller.signal.aborted) setResult({ source: loadRow, epoch, id: activeId, record: null, loading: false,
        error: error instanceof Error ? error : new Error(String(error)) });
    });
    return () => controller.abort();
  }, [activeId, loadRow, refreshKey, retryKey]);
  const preserveFocus = useRef(false);
  const attentionSequence = useRef(0);
  const [attentionRequest, setAttentionRequest] = useState({ revision: 0, pending: false });
  const attentionLatest = useRef({ loadRow, setQuery, modes, views, active, query });
  attentionLatest.current = { loadRow, setQuery, modes, views, active, query };
  useEffect(() => {
    const registry = config?.attention;
    if (!enabled || !registry) return;
    const provider: AttentionProvider = { reveal: async (target, signal) => {
      if (target.rowId === undefined || signal.aborted) return false;
      const current = attentionLatest.current;
      const record = await current.loadRow(target.rowId, signal);
      if (!record || signal.aborted) return false;
      if (target.field !== undefined && !detailSchema.fields.some(field => field.name === target.field
        && field.property?.enabled !== false && isPropertyFieldLoaded(field, record.loadedFields))) return false;
      const mode = current.active?.id === target.rowId ? current.active.mode : current.modes.includes("expand") ? "expand" : current.modes.includes("modal") ? "modal" : null;
      if (!mode || (target.field !== undefined && !current.views[mode].properties.some(property => property.field === target.field))) return false;
      preserveFocus.current = true;
      const revision = ++attentionSequence.current;
      setAttentionRequest({ revision, pending: true });
      try {
        current.setQuery(previous => ({ ...previous, itemDetails: { ...previous.itemDetails, modes: previous.itemDetails?.modes ?? current.modes,
          views: current.views, active: { id: target.rowId!, mode } } }));
        const mounted = await registry.whenRegistered({ dataset: detailSchema.name, rowId: target.rowId }, signal);
        if (mounted.ready) await mounted.ready(signal);
        return signal.aborted ? false : await mounted.reveal(target, signal);
      } finally {
        setAttentionRequest(previous => previous.revision === revision ? { revision, pending: false } : previous);
      }
    } };
    return registry.register({ dataset: detailSchema.name }, provider);
  }, [enabled, config?.attention, detailSchema]);
  if (!enabled) return;
  const looked = lookupRow && active ? lookupRow(active.id) : null;
  return {
    ...(subject ? { subject } : {}),
    ...(links ? { links } : {}),
    ...(config?.attention ? { attention: config.attention } : {}),
    preserveFocus: preserveFocus.current,
    attentionRevision: attentionRequest.revision,
    attentionPending: attentionRequest.pending,
    jsonInspections: query.itemDetails?.jsonInspections ?? [],
    setJsonInspection(entry) {
      if (entry.dataset !== detailSchema.name) return;
      setQuery(current => {
        // Most recently edited scopes stay at the end. Prefer evicting a closed
        // inspector, and always make room before strict query normalization.
        const inspections = (current.itemDetails?.jsonInspections ?? []).filter(previous => jsonInspectionScopeKey(previous) !== jsonInspectionScopeKey(entry));
        while (inspections.length >= MAX_JSON_INSPECTIONS) {
          const closed = inspections.findIndex(previous => !previous.state.open);
          inspections.splice(closed < 0 ? 0 : closed, 1);
        }
        return { ...current, itemDetails: { ...current.itemDetails, modes: current.itemDetails?.modes ?? modes,
          jsonInspections: [...inspections, entry] } };
      });
    },
    schema: detailSchema, queryParameter: queryParameter ?? config?.queryParameter ?? "q", properties: modalProperties, propertiesByMode, availableModes, modes, active,
    page, pageSchema: schema,
    record: lookupRow ? looked ?? null : result.id === activeId && result.source === loadRow ? result.record : null,
    loading: lookupRow ? looked === undefined : activeId !== undefined && (!currentResult || result.loading),
    error: lookupRow ? null : currentResult ? result.error : null,
    ...(config?.relationships ? { relationships: config.relationships } : {}),
    loadRow,
    retry: () => setRetryKey((value) => value + 1),
    setModes(next) {
      setQuery((current) => {
        const allowed = availableModes.filter((mode) => next.includes(mode));
        const state: ItemDetailsState = { ...current.itemDetails, modes: allowed, views };
        if (state.active && !allowed.includes(state.active.mode)) delete state.active;
        return { ...current, itemDetails: state };
      });
    },
    open(id, mode) {
      config?.attention?.cancel();
      preserveFocus.current = false;
      if (!modes.includes(mode)) return;
      setQuery((current) => ({ ...current, itemDetails: {
        ...current.itemDetails, modes: current.itemDetails?.modes ?? modes,
        views, active: { id, mode },
      } }));
    },
    close() {
      config?.attention?.cancel();
      setQuery((current) => {
        if (!current.itemDetails?.active) return current;
        const { active: _active, ...state } = current.itemDetails;
        return { ...current, itemDetails: state };
      });
    },
  };
}
