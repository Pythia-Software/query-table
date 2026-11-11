// Metric list pane (pane 0) of the MetricsEditor workbench: reorderable metrics
// and the create button. Plain render function, not a component.
import { MAX_AGGREGATIONS } from "@pythia-software/query-table-core";
import { ReorderList } from "../ReorderList";
import { Icon } from "../Icon";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The metric list pane. */
export function renderLibraryPane<Row>(state: MetricsEditorState<Row>) {
  const {
    fields, initial, drafts, active, setActive, createMetric, paneProps,
    paneHeading, move, issues, orderItems, menu,
  } = state;
  return (
    <aside
      className="qt-metric-library"
      {...paneProps(0)}
      aria-label="Metrics in this query"
    >
      {paneHeading(
        0,
        <>
          In this query <span>· {drafts.length}</span>
        </>,
      )}
      <ReorderList
        items={orderItems}
        onMove={move}
        showHint={false}
        itemClassName={(item) =>
          item.id === active ? "qt-metric-library-selected" : ""
        }
        renderItem={(item, index) => {
          const c = drafts.find((d) => d.id === item.id)!;
          return (
            <>
              <button
                type="button"
                className="qt-metric-library-chip"
                aria-current={item.id === active}
                onClick={() => setActive(item.id)}
              >
                <strong>
                  {item.label}
                  {issues.has(c.id) && (
                    <span
                      className="qt-metric-needs-attention"
                      aria-label="Needs attention"
                      title={issues.get(c.id)}
                    >
                      <Icon name="alert" size={12} />
                    </span>
                  )}
                  {JSON.stringify(c) !==
                    JSON.stringify(
                      initial.current.find((m) => m.id === c.id),
                    ) && (
                    <i
                      className="qt-metric-dirty-dot"
                      aria-label="Modified"
                    />
                  )}
                </strong>
                <span>
                  {c.groupBy
                    .map(
                      (g) => fields.find((f) => f.name === g)?.label ?? g,
                    )
                    .join(" × ") || "One value"}{" "}
                  ·{" "}
                  {c.scope === "shownRows"
                    ? "Shown rows"
                    : "All matching"}
                </span>
              </button>
              {menu(c, index)}
            </>
          );
        }}
      />
      <button
        type="button"
        className="qt-btn qt-metric-create"
        disabled={drafts.length >= MAX_AGGREGATIONS}
        onClick={createMetric}
      >
        + Create metric
      </button>
    </aside>
  );
}
