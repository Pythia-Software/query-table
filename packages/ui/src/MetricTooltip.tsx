import { createContext, useMemo, useState, type ReactNode, type SyntheticEvent } from "react";

interface Tooltip { label: string; color: string | undefined }

/** Lets a pointer layer show the mark it would pick, without a focusable target. */
export const MetricTooltipContext = createContext<{ show(label: string, color?: string): void; hide(): void } | null>(null);

/** Keep hover/focus state outside the chart so opening a tooltip does not
 * rebuild axes, formatted labels, or thousands of SVG marks. */
export function MetricTooltip({ id, children }: { id: string; children: ReactNode }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const show = (event: SyntheticEvent<HTMLDivElement>) => {
    const target = event.target;
    const mark = target instanceof Element ? target.closest(".qt-metric-mark[aria-label]") : null;
    if (!mark || !event.currentTarget.contains(mark)) return;
    const label = mark.getAttribute("aria-label")!;
    const color = mark.getAttribute("data-qt-metric-color") ?? undefined;
    setTooltip(previous => previous?.label === label && previous.color === color ? previous : { label, color });
  };
  const context = useMemo(() => ({
    show: (label: string, color?: string) =>
      setTooltip(previous => previous?.label === label && previous.color === color ? previous : { label, color }),
    hide: () => setTooltip(null),
  }), []);
  return <MetricTooltipContext.Provider value={context}><div className="qt-metric-chart-body" onMouseOver={show} onMouseOut={event => {
    const target = event.target instanceof Element ? event.target.closest(".qt-metric-mark") : null;
    if (target && (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget))) setTooltip(null);
  }} onMouseLeave={() => setTooltip(null)} onFocus={show} onBlur={() => setTooltip(null)}
    onKeyDown={event => {
      if (event.key === "Escape" && tooltip) {
        event.preventDefault();
        event.stopPropagation();
        setTooltip(null);
      }
    }}>
    {children}
    {tooltip && <div id={id} role="tooltip" className="qt-metric-tooltip">
      {tooltip.color && <span aria-hidden="true" className="qt-metric-swatch" style={{ background: tooltip.color }} />}
      <span>{tooltip.label}</span>
    </div>}
  </div></MetricTooltipContext.Provider>;
}
