import { useId, useRef, useState } from "react";
import type { FieldSchema } from "@pythia-software/query-table-core";
import { useQueryTable } from "@pythia-software/query-table-react";
import { Icon, QueryBuilder } from "@pythia-software/query-table-ui";
import "@pythia-software/query-table-ui/theme.css";
import "./demo.css";
import "./runActionsDemo.css";

interface Row { id: number }
const schema: FieldSchema<Row> = {
  name: "run-actions", idField: "id",
  fields: [{ name: "id", label: "ID", type: "number", source: { kind: "backend" } }],
};
const rows: Row[] = [{ id: 1 }, { id: 2 }];

// The host owns the button, local state, dialog and focus restoration.
function Readiness({ name }: { name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [opens, setOpens] = useState(0);
  return <>
    <button ref={button} type="button" className="qt-btn" aria-label={`${name} data readiness`}
      title="Data readiness" aria-haspopup="dialog" data-open-count={opens}
      onClick={() => { setOpens(n => n + 1); dialog.current?.showModal(); }}>
      <span className="run-actions-ready"><Icon name="check" /></span>
    </button>
    <dialog ref={dialog} className="run-actions-dialog" aria-labelledby={titleId}
      onClose={() => button.current?.focus()}>
      <h2 id={titleId}>{name} data readiness</h2>
      <p>These example results include all pending changes.</p>
      <p>Opened {opens} times.</p>
      <button type="button" className="qt-btn" onClick={() => dialog.current?.close()}>Close readiness</button>
    </dialog>
  </>;
}

function Example({ name, withSlot = true, defaultCollapsed = false }: {
  name: string; withSlot?: boolean; defaultCollapsed?: boolean;
}) {
  const api = useQueryTable({ schema, clientRows: rows, debounceMs: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  return <section data-builder={name}>
    <h2>{name}</h2>
    <div className="run-actions-fixture-controls">
      <label><input type="checkbox" checked={loading} onChange={e => setLoading(e.target.checked)} /> Simulate loading</label>
      <label><input type="checkbox" checked={error} onChange={e => setError(e.target.checked)} /> Simulate error</label>
    </div>
    <QueryBuilder api={{ ...api, loading, error: error ? new Error("Example request failed") : null }}
      fields={schema.fields} total={api.total} defaultCollapsed={defaultCollapsed}
      runActionsBeforeActivity={withSlot ? <Readiness name={name} /> : undefined}
      requestActivityDetails={<p>Host-owned request diagnostics.</p>} />
  </section>;
}

export function RunActionsDemo() {
  const [rerenders, setRerenders] = useState(0);
  const [showFirst, setShowFirst] = useState(true);
  return <main className="qt-demo run-actions-demo">
    <h1>Host content in the run bar</h1>
    <p>Each readiness control and its dialog belong to the host. Collapse the editor or start auto-update to try the persistent slot.</p>
    <div className="run-actions-fixture-controls">
      <button type="button" className="qt-btn" onClick={() => setRerenders(n => n + 1)}>Rerender host ({rerenders})</button>
      <button type="button" className="qt-btn" onClick={() => setShowFirst(v => !v)}>Toggle first builder</button>
    </div>
    {showFirst && <Example name="Orders" />}
    <Example name="Inventory" defaultCollapsed />
    <Example name="Without slot" withSlot={false} />
  </main>;
}
