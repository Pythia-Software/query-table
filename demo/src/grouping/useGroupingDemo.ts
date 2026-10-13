import { useEffect, useState } from "react";
import {
  localStorageAdapter,
  queriesEqual,
  type StorageAdapter,
} from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import {
  initialView,
  inputRows,
  inputSchema,
  parseView,
  seedViews,
  queryFromView,
  type SavedView,
  type View,
  type Row,
} from "./model";
const STORAGE_KEY = "query-table:grouping-prototype:v2";
const LEGACY_STORAGE_KEY = "query-table:grouping-prototype:v1";
const MIGRATION_MARKER = "query-table:grouping-library:migrated";
const BACKUP_KEY = `${STORAGE_KEY}:unreadable-backup`;
interface SavedState {
  items: SavedView[];
  defaultId: string | null;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const signature = (value: View) => JSON.stringify(value);

function preserveUnreadable(stored: string | null) {
  if (stored && !localStorage.getItem(BACKUP_KEY))
    localStorage.setItem(BACKUP_KEY, stored);
}
function unreadableNotice(errors: string[]): string {
  return errors.length
    ? `Some saved views could not be loaded; their original data is preserved. ${errors.join(" ")}`
    : "";
}
function boot(): { saved: SavedState; view: View; notice: string; stored: string | null } {
  let saved: SavedState = { items: seedViews(), defaultId: "runs" };
  let notice = "";
  let stored: string | null = null;
  try {
    // Keep the legacy key intact, including views that cannot be represented by
    // one shared row rule. Saving writes only the new format/key.
    stored = localStorage.getItem(MIGRATION_MARKER) ? null :
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as SavedState;
      if (!Array.isArray(parsed.items) || parsed.items.length > 100)
        throw new Error();
      const unreadable: string[] = [];
      saved = {
        items: parsed.items.flatMap((item, index) => {
          try {
            if (!item || typeof item.id !== "string" || typeof item.name !== "string")
              throw new Error("Invalid saved view.");
            if (typeof item.savedAt !== "number" || !Number.isFinite(item.savedAt))
              throw new Error("Invalid saved timestamp.");
            const view = parseView(item.view);
            return [
              {
                ...item,
                view,
                query: view.mode === "rows" ? view.input : view.result,
              },
            ];
          } catch (error) {
            unreadable.push(
              `${typeof item?.name === "string" ? item.name : `View ${index + 1}`}: ${error instanceof Error ? error.message : "Invalid view"}`,
            );
            return [];
          }
        }),
        defaultId:
          typeof parsed.defaultId === "string" ? parsed.defaultId : null,
      };
      if (unreadable.length) {
        // Archive the complete input before any later save can replace it.
        preserveUnreadable(stored);
        notice = unreadableNotice(unreadable);
      }
    }
  } catch {
    try { preserveUnreadable(stored); } catch { /* Storage may be unavailable. */ }
    notice =
      "Saved prototype views could not be read. The sample views are available.";
  }
  let view = clone(
    saved.items.find((item) => item.id === saved.defaultId)?.view ??
      initialView(),
  );
  const shared = new URLSearchParams(window.location.search).get("view");
  if (shared) {
    try {
      if (shared.length > 100_000) throw new Error();
      view = parseView(JSON.parse(shared));
    } catch (error) {
      notice = `This shared view could not be read. ${error instanceof Error ? error.message : ""} Loaded the default view.`;
    }
  }
  return { saved, view: parseView(view), notice, stored };
}

// Import old views once, through the standard storage adapter. The old keys
// remain intact so migration never destroys prototype snapshots.
let migration: { storage: StorageAdapter; ready: Promise<string> } | undefined;
function demoStorage(start: ReturnType<typeof boot>) {
  if (migration) return migration;
  const storage = localStorageAdapter();
  const ready = (async () => {
    if (localStorage.getItem(MIGRATION_MARKER)) return "";
    const unreadable: string[] = [];
    if (!(await storage.listSaved(inputSchema.name)).length) {
      for (const [index, item] of start.saved.items.entries()) {
        try {
          const saved = await storage.saveNamed(
            inputSchema.name,
            item.name,
            queryFromView(item.view),
            item.savedAt + index,
          );
          if (item.id === start.saved.defaultId)
            await storage.setDefaultSaved?.(inputSchema.name, saved.id);
        } catch (error) {
          // A rejected name or view must not abort later imports or poison the
          // promise awaited by every storage method for the rest of this visit.
          unreadable.push(`${item.name || "Unnamed view"}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (unreadable.length) preserveUnreadable(start.stored);
    // Existing library views also finish migration: never re-import or keep
    // warning about retained prototype snapshots on later visits.
    localStorage.setItem(MIGRATION_MARKER, "true");
    return unreadableNotice(unreadable);
  })().catch(error => `Prototype view import could not finish. The original prototype data is retained. ${error instanceof Error ? error.message : String(error)}`);
  const adapter = Object.fromEntries(
    Object.entries(storage).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        await ready;
        return fn(...args);
      },
    ]),
  ) as unknown as StorageAdapter;
  migration = { storage: adapter, ready };
  return migration;
}
export function useGroupingDemo() {
  const [start] = useState(boot);
  const [{ storage, ready }] = useState(() => demoStorage(start));
  const [importNotice, setImportNotice] = useState("");
  useEffect(() => {
    let active = true;
    void ready.then(notice => { if (active) setImportNotice(notice); });
    return () => { active = false; };
  }, [ready]);
  const params = new URLSearchParams(window.location.search);
  const api = useQueryTable<Row>({
    schema: inputSchema,
    clientRows: inputRows,
    storage,
    syncUrl: true,
    debounceMs: 0,
    ...(params.has("view") && !params.has("q")
      ? { initialQuery: queryFromView(start.view) }
      : {}),
  });
  return {
    api,
    startNotice: [start.notice, importNotice].filter(Boolean).join(" "),
    matchesSaved: (item: { id: string }) => {
      const saved = api.saved.items.find((saved) => saved.id === item.id);
      return !!saved && queriesEqual(saved.query, api.query);
    },
  };
}
