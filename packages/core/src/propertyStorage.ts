import { normalizePropertyView, type PropertyViewState } from "./properties";

export interface SavedPropertyView {
  id: string;
  name: string;
  savedAt: number;
  view: PropertyViewState;
}
export interface PropertyViewStorage {
  loadLast(objectType: string): Promise<PropertyViewState | null>;
  saveLast(objectType: string, view: PropertyViewState): Promise<void>;
  listSaved(objectType: string): Promise<SavedPropertyView[]>;
  saveNamed(
    objectType: string,
    name: string,
    view: PropertyViewState,
    savedAt: number,
  ): Promise<SavedPropertyView>;
  deleteSaved(objectType: string, id: string): Promise<void>;
  loadDefaultSaved(objectType: string): Promise<SavedPropertyView | null>;
  setDefaultSaved(objectType: string, id: string | null): Promise<void>;
}
interface StoredViews {
  last: PropertyViewState | null;
  saved: SavedPropertyView[];
  defaultId: string | null;
}
const empty = (): StoredViews => ({ last: null, saved: [], defaultId: null });
const clone = (saved: SavedPropertyView): SavedPropertyView => ({
  ...saved,
  view: normalizePropertyView(saved.view),
});

/** The JSON-backed factory also supports application-owned synchronous preferences. */
export function jsonPropertyViewStorage(
  read: (key: string) => string | null,
  write: (key: string, value: string) => void,
): PropertyViewStorage {
  const keyFor = (type: string) => `query-table:properties:${type}`;
  function load(type: string): StoredViews {
    const value = read(keyFor(type));
    if (value === null) return empty();
    const raw = JSON.parse(value) as StoredViews;
    if (
      !raw ||
      !Array.isArray(raw.saved) ||
      raw.saved.length > 100 ||
      !(raw.defaultId === null || typeof raw.defaultId === "string")
    )
      throw new Error("Invalid saved property views.");
    const saved = raw.saved.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        item.name.length > 200 ||
        !Number.isFinite(item.savedAt)
      )
        throw new Error("Invalid saved property view.");
      return clone(item);
    });
    return {
      last: raw.last === null ? null : normalizePropertyView(raw.last),
      saved,
      defaultId: raw.defaultId,
    };
  }
  const store = (type: string, value: StoredViews) =>
    write(keyFor(type), JSON.stringify(value));
  return {
    async loadLast(type) {
      return load(type).last;
    },
    async saveLast(type, view) {
      const data = load(type);
      data.last = normalizePropertyView(view);
      store(type, data);
    },
    async listSaved(type) {
      return load(type).saved;
    },
    async saveNamed(type, name, view, savedAt) {
      name = name.trim();
      if (!name || name.length > 200 || !Number.isFinite(savedAt))
        throw new Error(
          "A view name (1–200 characters) and valid save time are required.",
        );
      const data = load(type);
      if (data.saved.some((v) => v.name === name))
        throw new Error(`A property view named “${name}” already exists.`);
      if (data.saved.length >= 100)
        throw new Error("At most 100 saved property views are allowed.");
      let suffix = 0;
      while (data.saved.some((v) => v.id === `${savedAt}-${suffix}`)) suffix++;
      const saved = {
        id: `${savedAt}-${suffix}`,
        name,
        savedAt,
        view: normalizePropertyView(view),
      };
      data.saved.push(saved);
      store(type, data);
      return clone(saved);
    },
    async deleteSaved(type, id) {
      const data = load(type);
      data.saved = data.saved.filter((v) => v.id !== id);
      if (data.defaultId === id) data.defaultId = null;
      store(type, data);
    },
    async loadDefaultSaved(type) {
      const data = load(type);
      return data.saved.find((v) => v.id === data.defaultId) ?? null;
    },
    async setDefaultSaved(type, id) {
      const data = load(type);
      if (id !== null && !data.saved.some((v) => v.id === id))
        throw new Error("Unknown property view.");
      data.defaultId = id;
      store(type, data);
    },
  };
}
export function memoryPropertyViewStorage(): PropertyViewStorage {
  const values = new Map<string, string>();
  return jsonPropertyViewStorage(
    (key) => values.get(key) ?? null,
    (key, value) => {
      values.set(key, value);
    },
  );
}
/** Durable browser persistence is explicitly opt-in, independently of table storage. */
export function localPropertyViewStorage(): PropertyViewStorage {
  return jsonPropertyViewStorage(
    (key) => localStorage.getItem(key),
    (key, value) => localStorage.setItem(key, value),
  );
}
