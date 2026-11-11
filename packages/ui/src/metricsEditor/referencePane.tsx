// Fields & functions reference pane (pane 2) of the MetricsEditor workbench.
// Plain render function, not a component.
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The field and function library pane. */
export function renderReferencePane<Row>(state: MetricsEditorState<Row>) {
  const {
    reference, setReference, search, setSearch, concept, setConcept, paneProps,
    paneHeading, insert, referenceItems,
  } = state;
  return (
    <aside
      className="qt-metric-reference"
      {...paneProps(2)}
      aria-label="Field and function library"
    >
      {paneHeading(2, "Fields & functions")}
      <select
        aria-label="Reference library"
        value={reference}
        onChange={(e) => setReference(e.target.value as typeof reference)}
      >
        <option value="fields">Fields</option>
        <option value="functions">Functions</option>
      </select>
      <label>
        Search {reference}
        <input
          aria-label="Search metric reference"
          type="search"
          placeholder="Name or purpose"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {reference === "functions" && (
        <label>
          Concept
          <select
            aria-label="Function concept"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
          >
            <option value="all">All functions</option>
            <option value="aggregate">Aggregation</option>
            <option value="row">Row arithmetic & conditions</option>
          </select>
        </label>
      )}
      <div className="qt-metric-reference-columns" aria-hidden="true">
        <span>Type</span>
        <span>Name</span>
        <span>{reference === "fields" ? "ID" : "Signature"}</span>
      </div>
      <div className="qt-metric-reference-list">
        {referenceItems.map((item) => (
          <button
            type="button"
            className="qt-metric-reference-item"
            key={item.name}
            title={`${item.label} · ${item.detail}
${item.description}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              insert(item.wrap ? item.name : item.detail, item.wrap)
            }
          >
            <span>{item.type}</span>
            <strong>{item.label}</strong>
            <code>
              {reference === "fields" ? item.name : item.detail}
            </code>
          </button>
        ))}
        {referenceItems.length === 0 && (
          <p className="qt-metric-help" role="status">
            No {reference} match “{search}”.
          </p>
        )}
      </div>
      <p className="qt-metric-help">
        Insert at the cursor. Select expression text to wrap it in a
        function.
      </p>
    </aside>
  );
}
