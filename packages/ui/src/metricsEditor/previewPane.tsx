// Live preview pane (pane 3) of the MetricsEditor workbench: the resizable
// card preview and bucket inspection. Plain render function, not a component.
import { Icon } from "../Icon";
import { defaultLayout } from "./shared";
import { MetricNumberInput } from "./controls";
import { MetricInspection } from "./MetricInspection";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The live preview pane. */
export function renderPreviewPane<Row>(state: MetricsEditorState<Row>) {
  const {
    locale, error, previewLoading, setRetry, previewSize, setPreviewSize,
    inspectOpen, setInspectOpen, setInspectedKey, previewContainer, selected,
    diagnostics, paneProps, panelToggle, selectedResult, inspectedBucket, card,
  } = state;
  return (
    <section className="qt-metric-live-preview" {...paneProps(3)}>
      <div className="qt-metric-preview-heading">
        <h3>Live preview</h3>
        <span className="qt-metric-preview-status" role="status">
          {previewLoading
            ? "Calculating…"
            : selectedResult?.error ||
                error ||
                (selected && diagnostics.has(selected.id))
              ? "Needs attention"
              : selectedResult?.coverage === "exact"
                ? "Complete results"
                : selectedResult?.coverage === "partial"
                  ? "Partial results"
                  : "Preview"}
        </span>
        {panelToggle(3, true)}
      </div>
      {selected && (
        <>
          <p className="qt-metric-preview-scope">
            {selected.scope === "shownRows"
              ? "Shown rows on this page"
              : "All matching rows"}
          </p>
          <p className="qt-metric-help">
            Aggregate input rows, then apply result ordering and display.
          </p>
          <div className="qt-metric-preview-controls">
            <label>
              Width (px)
              <MetricNumberInput
                key={selected.id}
                aria-label="Preview width"
                min={100}
                max={1800}
                value={previewSize.width}
                onCommit={(n) => {
                  if (Number.isFinite(n))
                    setPreviewSize((previous) => ({
                      ...previous,
                      width: Math.max(100, Math.min(1800, n)),
                    }));
                }}
              />
            </label>
            <label>
              Height (px)
              <MetricNumberInput
                key={selected.id}
                aria-label="Preview height"
                min={60}
                max={1000}
                value={previewSize.height}
                onCommit={(n) => {
                  if (Number.isFinite(n))
                    setPreviewSize((previous) => ({
                      ...previous,
                      height: Math.max(60, Math.min(1000, n)),
                    }));
                }}
              />
            </label>
            <button
              type="button"
              className="qt-btn"
              onClick={() => {
                const layout = selected.layout ?? defaultLayout;
                const rem =
                  parseFloat(
                    getComputedStyle(document.documentElement).fontSize,
                  ) || 16;
                setPreviewSize({
                  width: layout.widthRem * rem,
                  height: layout.heightRem * rem,
                });
              }}
            >
              Use card size
            </button>
            <button
              type="button"
              className="qt-btn qt-metric-refresh"
              aria-label="Refresh preview"
              title="Refresh preview"
              onClick={() => setRetry((value) => value + 1)}
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div
            ref={previewContainer}
            className="qt-metric-preview-card"
            style={{
              width: previewSize.width,
              height: previewSize.height,
            }}
          >
            {card(selected)}
          </div>
          <p className="qt-metric-help">
            Drag the lower-right corner to resize. Preview dimensions are
            temporary.
          </p>
          {selectedResult?.processedRows !== undefined && (
            <p className="qt-muted">
              {selectedResult.processedRows.toLocaleString(locale)} input
              rows · {selectedResult.buckets.length} of{" "}
              {selectedResult.groupCount ?? selectedResult.buckets.length}{" "}
              groups
              {selectedResult.hiddenGroups
                ? ` · ${selectedResult.hiddenGroups.toLocaleString(locale)} hidden`
                : ""}
            </p>
          )}
          {inspectedBucket && (
            <details
              className="qt-metric-settings qt-metric-inspection"
              open={inspectOpen}
              onToggle={(e) => setInspectOpen(e.currentTarget.open)}
            >
              <summary>
                <strong>Inspect result</strong>
                <span>
                  {inspectedBucket.keys
                    .map((k) => (k === null ? "NULL" : String(k)))
                    .join(" / ") || "One value"}
                </span>
              </summary>
              <div>
                {selectedResult && selectedResult.buckets.length > 1 && (
                  <label>
                    Result group
                    <select
                      aria-label="Inspect result group"
                      value={JSON.stringify(inspectedBucket.keys)}
                      onChange={(e) => setInspectedKey(e.target.value)}
                    >
                      {selectedResult.buckets.map((b) => (
                        <option
                          key={JSON.stringify(b.keys)}
                          value={JSON.stringify(b.keys)}
                        >
                          {b.keys
                            .map((k) => (k === null ? "NULL" : String(k)))
                            .join(" / ")}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <MetricInspection
                  bucket={inspectedBucket}
                  clause={selected}
                  locale={locale}
                />
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
