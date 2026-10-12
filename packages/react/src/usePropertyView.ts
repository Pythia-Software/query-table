import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPropertyView,
  memoryPropertyViewStorage,
  normalizePropertyView,
  type FieldSchema,
  type PropertyViewState,
  type PropertyViewStorage,
  type SavedPropertyView,
} from "@pythia-software/query-table-core";

export interface UsePropertyViewOptions<Row> {
  schema: FieldSchema<Row>;
  /** Object type, never object ID. Defaults to schema.name. */
  key?: string;
  storage?: PropertyViewStorage;
  initialView?: PropertyViewState;
}
export interface PropertyViewApi {
  view: PropertyViewState;
  loading: boolean;
  error: Error | null;
  saved: SavedPropertyView[];
  defaultId: string | null;
  setView(view: PropertyViewState): void;
  reset(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  load(id: string): void;
  save(name: string): Promise<SavedPropertyView>;
  remove(id: string): Promise<void>;
  setDefault(id: string | null): Promise<void>;
}
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

/** Owns presentation only. Changing the inspected row never resets this controller. */
export function usePropertyView<Row>(
  options: UsePropertyViewOptions<Row>,
): PropertyViewApi {
  const [memory] = useState(memoryPropertyViewStorage);
  const storage = options.storage ?? memory;
  const key = options.key ?? options.schema.name;
  const schemaDefault = useMemo(() => createPropertyView(options.schema), [options.schema]);
  const fallback = useMemo(
    () =>
      options.initialView
        ? normalizePropertyView(options.initialView)
        : schemaDefault,
    [options.initialView, schemaDefault],
  );
  const defaults = useRef(schemaDefault);
  defaults.current = schemaDefault;
  const initial = useRef(options.initialView);
  initial.current = options.initialView;
  const [state, setState] = useState({
    key,
    storage,
    history: [fallback],
    index: 0,
    loading: true,
    error: null as Error | null,
    saved: [] as SavedPropertyView[],
    defaultId: null as string | null,
  });
  const generation = useRef(0);
  const edits = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const current = state.key === key && state.storage === storage;
  const view = current ? state.history[state.index]! : fallback;

  useEffect(() => {
    const token = ++generation.current;
    const editToken = edits.current;
    setState({
      key,
      storage,
      history: [defaults.current],
      index: 0,
      loading: true,
      error: null,
      saved: [],
      defaultId: null,
    });
    void Promise.resolve()
      .then(() =>
        Promise.all([
          storage.loadLast(key),
          storage.listSaved(key),
          storage.loadDefaultSaved(key),
        ]),
      )
      .then(([last, saved, defaultView]) => {
        if (generation.current !== token) return;
        const restored = normalizePropertyView(
          initial.current ?? last ?? defaultView?.view ?? defaults.current,
        );
        const items = saved.map((item) => ({
          ...item,
          view: normalizePropertyView(item.view),
        }));
        setState((previous) => ({
          ...previous,
          ...(edits.current === editToken
            ? { history: [restored], index: 0 }
            : {}),
          saved: items,
          defaultId: defaultView?.id ?? null,
          loading: false,
        }));
      })
      .catch((error) => {
        if (generation.current === token)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: asError(error),
          }));
      });
    return () => {
      generation.current++;
    };
  }, [key, storage]);

  useEffect(() => {
    if (!current || state.loading || state.error) return;
    const token = generation.current;
    const snapshot = normalizePropertyView(view);
    // Serial writes prevent a slower old save from replacing a newer view.
    saveQueue.current = saveQueue.current
      .then(() => storage.saveLast(key, snapshot))
      .catch((error) => {
        if (generation.current === token)
          setState((previous) => ({ ...previous, error: asError(error) }));
      });
  }, [view, current, state.loading, state.error, key, storage]);

  const setView = useCallback(
    (next: PropertyViewState) => {
      const normalized = normalizePropertyView(next);
      edits.current++;
      setState((previous) => {
        const history =
          previous.key === key && previous.storage === storage
            ? previous.history.slice(0, previous.index + 1)
            : [defaults.current];
        if (
          JSON.stringify(history[history.length - 1]) ===
          JSON.stringify(normalized)
        )
          return { ...previous, error: null };
        const nextHistory = [...history, normalized].slice(-50);
        return {
          ...previous,
          key,
          storage,
          history: nextHistory,
          index: nextHistory.length - 1,
          error: null,
        };
      });
    },
    [key, storage],
  );
  const refresh = useCallback(
    async (token: number) => {
      const [saved, defaultView] = await Promise.all([
        storage.listSaved(key),
        storage.loadDefaultSaved(key),
      ]);
      if (generation.current === token)
        setState((previous) => ({
          ...previous,
          saved: saved.map((item) => ({
            ...item,
            view: normalizePropertyView(item.view),
          })),
          defaultId: defaultView?.id ?? null,
          error: null,
        }));
    },
    [key, storage],
  );
  return {
    view,
    loading: !current || state.loading,
    error: current ? state.error : null,
    saved: current ? state.saved : [],
    defaultId: current ? state.defaultId : null,
    setView,
    reset: () => setView(defaults.current),
    canUndo: current && state.index > 0,
    canRedo: current && state.index < state.history.length - 1,
    undo() {
      edits.current++;
      setState((previous) => ({
        ...previous,
        index: Math.max(0, previous.index - 1),
        error: null,
      }));
    },
    redo() {
      edits.current++;
      setState((previous) => ({
        ...previous,
        index: Math.min(previous.history.length - 1, previous.index + 1),
        error: null,
      }));
    },
    load(id) {
      const found = state.saved.find((item) => item.id === id);
      if (found && current) setView(found.view);
    },
    async save(name) {
      const token = generation.current;
      const saved = await storage.saveNamed(key, name, view, Date.now());
      await refresh(token);
      return saved;
    },
    async remove(id) {
      const token = generation.current;
      await storage.deleteSaved(key, id);
      await refresh(token);
    },
    async setDefault(id) {
      const token = generation.current;
      await storage.setDefaultSaved(key, id);
      await refresh(token);
    },
  };
}
