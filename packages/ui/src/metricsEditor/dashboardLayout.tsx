// Dashboard view of the MetricsEditor: canvas width controls, card layout
// controls and the resizable card canvas. Plain render function, not a component.
import { MAX_AGGREGATIONS } from "@pythia-software/query-table-core";
import { ReorderList } from "../ReorderList";
import { Icon } from "../Icon";
import { defaultLayout, titleOf } from "./shared";
import { MetricNumberInput } from "./controls";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The "Dashboard layout" view. */
export function renderDashboardLayout<Row>(state: MetricsEditorState<Row>) {
  const {
    fields, drafts, active, setActive, canvas, setCanvas, returnMetric,
    geometryDrag, canvasElement, selected, navigate, createMetric, canvasWidth,
    patch, move, orderItems, menu, sizeControls, card,
  } = state;
  return (
    <section className="qt-metric-layout-editor">
      <div className="qt-metric-canvas-controls">
        <div className="qt-metric-canvas-heading">
          <strong>Dashboard layout</strong>
          <p className="qt-metric-help">
            Select a card to adjust it. Drag handles to reorder, corners to
            resize.
          </p>
        </div>
        {returnMetric && drafts.some((c) => c.id === returnMetric) && (
          <button
            type="button"
            className="qt-btn qt-metric-return"
            title={`Return to ${titleOf(
              drafts.find((c) => c.id === returnMetric)!,
              fields,
            )}`}
            onClick={() => navigate("editor", returnMetric)}
          >
            <Icon name="arrowLeft" />
            Back to metric
          </button>
        )}
        <button
          type="button"
          className="qt-btn"
          disabled={drafts.length >= MAX_AGGREGATIONS}
          onClick={createMetric}
        >
          <Icon name="add" />
          Create metric
        </button>
        <div
          className="qt-metric-canvas-presets"
          role="group"
          aria-label="Viewport presets"
        >
          <label>
            Canvas width (px)
            <MetricNumberInput
              aria-label="Canvas width"
              min={320}
              max={2400}
              step={10}
              value={canvas}
              onCommit={canvasWidth}
            />
          </label>
          <span>or preset</span>
          {([360, 768, 1200] as const).map((width) => (
            <button
              type="button"
              className="qt-btn"
              key={width}
              aria-pressed={canvas === width}
              onClick={() => setCanvas(width)}
            >
              {width === 360
                ? "Phone"
                : width === 768
                  ? "Tablet"
                  : "Desktop"}{" "}
              · {width}
            </button>
          ))}
        </div>
      </div>
      <div className="qt-metric-layout-controls">
        <label className="qt-metric-layout-picker">
          Selected metric
          <select
            aria-label="Selected metric"
            value={active}
            onChange={(e) => setActive(e.target.value)}
          >
            {orderItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <label className="qt-metric-layout-name">
            Name
            <input
              aria-label="Layout metric name"
              maxLength={1000}
              value={selected.label ?? titleOf(selected, fields)}
              onChange={(e) =>
                patch(selected.id, { label: e.target.value })
              }
            />
          </label>
        )}
        {sizeControls}
        <button
          type="button"
          className="qt-btn"
          disabled={!selected}
          onClick={() => navigate("editor")}
        >
          Edit metric
        </button>
      </div>
      <div className="qt-metric-canvas-scroll">
        <div
          className="qt-metric-canvas-frame"
          style={{ width: canvas + 18 }}
        >
          <div
            ref={canvasElement}
            className="qt-metric-layout-canvas"
            style={{ width: canvas }}
          >
            <ReorderList
              items={orderItems}
              layout="wrap"
              showHint={false}
              className="qt-metric-layout-items"
              onMove={move}
              itemClassName={(item) =>
                item.id === active ? "qt-metric-layout-selected" : ""
              }
              itemStyle={(item) => {
                const c = drafts.find((d) => d.id === item.id)!,
                  layout = c.layout ?? defaultLayout;
                return {
                  flexBasis: `${layout.widthRem}rem`,
                  minWidth: `${layout.minWidthRem}rem`,
                  minHeight: `${layout.minHeightRem}rem`,
                  height: `${Math.max(layout.heightRem, layout.minHeightRem)}rem`,
                  flexGrow: 1,
                };
              }}
              renderItem={(item, index) => {
                const c = drafts.find((d) => d.id === item.id)!;
                return (
                  <div
                    className="qt-metric-layout-card"
                    data-metric-id={item.id}
                    tabIndex={0}
                    aria-label={`Select ${item.label}`}
                    aria-current={item.id === active}
                    title={`${item.label} · Double-click to edit`}
                    onFocus={() => setActive(item.id)}
                    onDoubleClick={(e) => {
                      if (
                        !(e.target as Element).closest(
                          "button, input, select, textarea, summary, a, [role=button]",
                        )
                      )
                        navigate("editor", item.id);
                    }}
                    onClick={(e) => {
                      if (
                        !(e.target as Element).closest(
                          "button, input, select, textarea, summary, a",
                        )
                      )
                        setActive(item.id);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.currentTarget === e.target &&
                        (e.key === "Enter" || e.key === " ")
                      ) {
                        e.preventDefault();
                        setActive(item.id);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="qt-btn qt-metric-card-edit qt-metric-icon-button"
                      aria-label={`Edit ${item.label}`}
                      title="Edit metric"
                      onClick={() => navigate("editor", item.id)}
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                    {menu(c, index)}
                    {card(c)}
                    <button
                      type="button"
                      className="qt-metric-card-resize"
                      aria-label={`Resize ${item.label}`}
                      title="Drag to resize card. Arrow keys adjust width and height; Shift for larger steps."
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        setActive(c.id);
                        const original = c.layout,
                          base = { ...(original ?? defaultLayout) };
                        const rem =
                          parseFloat(
                            getComputedStyle(document.documentElement)
                              .fontSize,
                          ) || 16;
                        geometryDrag.start(
                          e,
                          (dx, dy) => {
                            const widthRem = Math.max(
                              base.minWidthRem,
                              Math.min(
                                75,
                                Math.round(base.widthRem + dx / rem),
                              ),
                            );
                            const heightRem = Math.max(
                              base.minHeightRem,
                              Math.min(
                                75,
                                Math.round(base.heightRem + dy / rem),
                              ),
                            );
                            patch(c.id, {
                              layout:
                                widthRem === base.widthRem &&
                                heightRem === base.heightRem
                                  ? original
                                  : { ...base, widthRem, heightRem },
                            });
                          },
                          () => patch(c.id, { layout: original }),
                        );
                      }}
                      onKeyDown={(e) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                          ].includes(e.key)
                        )
                          return;
                        e.preventDefault();
                        e.stopPropagation();
                        const base = c.layout ?? defaultLayout,
                          step = e.shiftKey ? 4 : 1;
                        const layout = {
                          ...base,
                          widthRem: Math.max(
                            base.minWidthRem,
                            Math.min(
                              75,
                              e.key === "Home"
                                ? defaultLayout.widthRem
                                : base.widthRem +
                                    (e.key === "ArrowRight"
                                      ? step
                                      : e.key === "ArrowLeft"
                                        ? -step
                                        : 0),
                            ),
                          ),
                          heightRem: Math.max(
                            base.minHeightRem,
                            Math.min(
                              75,
                              e.key === "Home"
                                ? defaultLayout.heightRem
                                : base.heightRem +
                                    (e.key === "ArrowDown"
                                      ? step
                                      : e.key === "ArrowUp"
                                        ? -step
                                        : 0),
                            ),
                          ),
                        };
                        if (
                          layout.widthRem !== base.widthRem ||
                          layout.heightRem !== base.heightRem
                        )
                          patch(c.id, { layout });
                      }}
                    >
                      <Icon name="resize" size={14} />
                    </button>
                  </div>
                );
              }}
            />
            {!drafts.length && (
              <div className="qt-metric-authoring-empty">
                <Icon name="dashboard" size={28} />
                <strong>Your dashboard is empty</strong>
                <p>Create a metric to start arranging your dashboard.</p>
                <button
                  type="button"
                  className="qt-btn"
                  onClick={createMetric}
                >
                  <Icon name="add" />
                  Create your first metric
                </button>
              </div>
            )}
          </div>
          <div
            className="qt-metric-canvas-resize"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize dashboard canvas"
            aria-valuemin={320}
            aria-valuemax={2400}
            aria-valuenow={canvas}
            aria-valuetext={`${canvas} pixels`}
            title="Drag to resize canvas. Left / Right adjust width; Home or double-click resets."
            onPointerDown={(e) => {
              const initial = canvas;
              geometryDrag.start(
                e,
                (dx) => canvasWidth(initial + dx),
                () => setCanvas(initial),
              );
            }}
            onDoubleClick={() => setCanvas(1120)}
            onKeyDown={(e) => {
              if (e.key === "Home") {
                e.preventDefault();
                setCanvas(1120);
              }
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                canvasWidth(
                  canvas +
                    (e.key === "ArrowLeft" ? -1 : 1) *
                      (e.shiftKey ? 50 : 10),
                );
              }
            }}
          >
            <Icon name="grip" size={14} />
          </div>
        </div>
      </div>
      <p className="qt-metric-canvas-note qt-metric-help">
        {canvas} px canvas · Drag the right edge to test wrapping. Card
        widths are preferred sizes; cards expand to fill each row.
      </p>
    </section>
  );
}
