// SavedQueriesModal — list / load / delete named saved queries. Thin view over
// api.saved; loading one pushes its QueryState into the controller (and the URL).

import { type ReactNode } from "react";
import type { SavedQueriesApi } from "@pythia-software/query-table-react";
import { ModalSurface } from "./AdaptiveOverlay";

export interface SavedQueriesModalProps {
  saved: SavedQueriesApi;
  onClose: () => void;
  onLoad?: (savedId: string) => void;
}

export function SavedQueriesModal({ saved, onClose, onLoad }: SavedQueriesModalProps): ReactNode {
  return (
    <ModalSurface title="Saved queries" onClose={onClose}>
      <div className="qt-overlay-body">
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
      </div>
    </ModalSurface>
  );
}
