// SavedQueriesModal — list / load / delete named saved queries. Thin view over
// api.saved; loading one pushes its QueryState into the controller (and the URL).

import { useEffect, type ReactNode } from "react";
import type { SavedQueriesApi } from "@pythia-software/query-table-react";

export interface SavedQueriesModalProps {
  saved: SavedQueriesApi;
  onClose: () => void;
  onLoad?: (savedId: string) => void;
}

export function SavedQueriesModal({ saved, onClose, onLoad }: SavedQueriesModalProps): ReactNode {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="qt-modal-backdrop" onClick={onClose}>
      <div
        className="qt-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Saved queries"
      >
        <h3 className="qt-modal-title">Saved queries</h3>
        {saved.loading ? (
          <p className="qt-muted">Loading…</p>
        ) : saved.items.length === 0 ? (
          <p className="qt-muted">None saved yet. Save the current query from the toolbar.</p>
        ) : (
          <ul className="qt-saved-list">
            {saved.items.map((s) => {
              const filters = s.query.where.length;
              const isDefault = saved.defaultId === s.id;
              return (
                <li key={s.id} className="qt-saved-item">
                  <button
                    type="button"
                    className="qt-saved-pick"
                    onClick={() => {
                      onLoad?.(s.id);
                      saved.load(s.id);
                      onClose();
                    }}
                  >
                    <span className="qt-saved-name">{s.name}</span>
                    <span className="qt-saved-meta qt-muted">
                      {isDefault ? "Default view · " : ""}
                      {new Date(s.savedAt).toLocaleString()} · {filters} filter{filters === 1 ? "" : "s"}
                    </span>
                  </button>
                  {isDefault ? (
                    <button
                      type="button"
                      className="qt-btn qt-saved-default"
                      title="Clear default view"
                      onClick={() => void saved.clearDefault()}
                    >
                      default
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="qt-btn qt-saved-default"
                      title="Use as default view"
                      onClick={() => void saved.setDefault(s.id)}
                    >
                      make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="qt-btn qt-saved-delete"
                    title="Delete saved query"
                    onClick={() => void saved.remove(s.id)}
                  >
                    delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="qt-modal-footer">
          <button type="button" className="qt-btn" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
