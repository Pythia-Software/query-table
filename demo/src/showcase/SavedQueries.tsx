import { useRef, useState, type FormEvent } from "react";
import type { SavedQuery } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import {
  Icon,
  ModalSurface,
  SavedQueriesModal,
} from "@pythia-software/query-table-ui";
import { isExampleQuery } from "./storage";
import type { Dataset } from "./data";

export function SavedQueries<Row>({
  api,
  dataset,
  selectedId,
  onLoad,
}: {
  api: QueryTableApi<Row>;
  dataset: Dataset;
  selectedId: string | null;
  onLoad(id: string): void;
}) {
  const [manage, setManage] = useState(false);
  const examples = api.saved.items.filter((item) => isExampleQuery(item.id));
  const personal = api.saved.items.filter((item) => !isExampleQuery(item.id));
  function list(items: SavedQuery[]) {
    return (
      <div className="showcase-saved-list">
        {items.map((item) => {
          const description = dataset.recipes.find(
            (recipe) => recipe.name === item.name,
          )?.description;
          return (
            <button
              type="button"
              key={item.id}
              data-saved-id={item.id}
              className={`showcase-saved-pick${selectedId === item.id ? " active" : ""}`}
              aria-label={item.name}
              aria-pressed={selectedId === item.id}
              title={description ?? item.name}
              onClick={() => {
                api.saved.load(item.id);
                onLoad(item.id);
              }}
            >
              <Icon
                name={item.query.grouping ? "dashboard" : "bookmark"}
                size={15}
              />
              <span>{item.name}</span>
              {api.saved.defaultId === item.id && <small>Default</small>}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <nav className="showcase-saved" aria-label="Saved queries">
      <div className="showcase-sidebar-heading">
        <h2>Saved queries</h2>
        <span>{api.saved.items.length}</span>
      </div>
      <h3>Examples</h3>
      {api.saved.loading ? (
        <p className="showcase-muted" role="status">
          Loading queries…
        </p>
      ) : (
        list(examples)
      )}
      <div className="showcase-personal-heading">
        <h3>Yours</h3>
        <button
          type="button"
          className="showcase-text-button"
          disabled={!personal.length}
          onClick={() => setManage(true)}
        >
          Manage
        </button>
      </div>
      {personal.length ? (
        list(personal)
      ) : (
        <p className="showcase-saved-empty">Saved views appear here.</p>
      )}
      {manage && (
        <SavedQueriesModal
          saved={{ ...api.saved, items: personal }}
          onClose={() => setManage(false)}
          onLoad={onLoad}
        />
      )}
    </nav>
  );
}

export function SaveQueryDialog<Row>({
  api,
  onClose,
  onSaved,
}: {
  api: QueryTableApi<Row>;
  onClose(): void;
  onSaved(saved: SavedQuery): void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saved.save(name);
      onSaved(saved);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <ModalSurface
      title="Save query"
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <form
        className="showcase-save-form"
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor="showcase-query-name">Query name</label>
        <input
          id="showcase-query-name"
          autoFocus
          maxLength={200}
          placeholder="My view"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <p>
          Filters, columns, sorting, and metrics are saved together in this
          browser.
        </p>
        {error && (
          <p className="showcase-form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button
            type="button"
            className="qt-btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="qt-btn qt-btn-primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Saving…" : "Save view"}
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}
