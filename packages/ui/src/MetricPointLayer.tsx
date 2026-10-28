import { useContext, useState, type MouseEvent, type PointerEvent } from "react";
import { MetricTooltipContext } from "./MetricTooltip";
import type { MetricBucket } from "./metricTypes";

export interface MetricPoint {
  x: number;
  y: number;
  bucket: MetricBucket;
  label: string;
  color: string;
}

/** Pointer reach around a point's 4px mark, in chart pixels. */
const reach = 12;

/**
 * The point nearest `(x, y)` within reach. Exact ties go to the point drawn
 * last, which is the one visible on top.
 */
export function nearestMetricPoint(points: readonly MetricPoint[], x: number, y: number): number {
  let best = -1, distance = reach * reach;
  points.forEach((point, i) => {
    const d = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (d <= distance) {
      best = i;
      distance = d;
    }
  });
  return best;
}

/**
 * Resolves pointer hits on line and scatter charts to the nearest drawn
 * point, so overlapping hit areas of crossing or coincident series never
 * cover a visible mark. Points stay individually focusable for keyboards.
 */
export function MetricPointLayer({ points, x, y, width, height, onInspect }: {
  points: readonly MetricPoint[];
  x: number;
  y: number;
  width: number;
  height: number;
  onInspect: ((bucket: MetricBucket) => void) | undefined;
}) {
  const tooltip = useContext(MetricTooltipContext);
  const [active, setActive] = useState(-1);
  const locate = (event: PointerEvent<SVGRectElement> | MouseEvent<SVGRectElement>) => {
    const svg = event.currentTarget.ownerSVGElement,
      box = svg?.getBoundingClientRect(),
      [vx = 0, vy = 0, vw = 0, vh = 0] = (svg?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    if (!box || !box.width || !box.height || !vw || !vh) return -1;
    return nearestMetricPoint(
      points,
      vx + ((event.clientX - box.left) * vw) / box.width,
      vy + ((event.clientY - box.top) * vh) / box.height,
    );
  };
  const hover = (index: number) => {
    setActive(index);
    const point = points[index];
    if (point) tooltip?.show(point.label, point.color);
    else tooltip?.hide();
  };
  const point = points[active];
  return (
    <g className="qt-metric-point-layer">
      {point && (
        <circle
          className="qt-metric-point-focus"
          cx={point.x}
          cy={point.y}
          r={7}
          fill="none"
          stroke={point.color}
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
      <rect
        aria-hidden="true"
        x={x - reach}
        y={y - reach}
        width={width + reach * 2}
        height={height + reach * 2}
        fill="transparent"
        style={{ cursor: point && onInspect ? "pointer" : undefined }}
        onPointerMove={(event) => hover(locate(event))}
        onPointerLeave={() => hover(-1)}
        onClick={(event) => {
          const index = locate(event);
          hover(index);
          if (points[index]) onInspect?.(points[index]!.bucket);
        }}
      />
    </g>
  );
}
