import { Icon } from "./Icon";
import { useRef, useState, type ReactNode } from "react";

export interface ReorderItem {
  id: string;
  label: string;
}

interface ReorderGesture {
  id: string;
  position: number;
  target: number;
  scrollTop: number;
  layout: Array<{ id: string; top: number; left: number; width: number; height: number; advance: number }>;
}

export function ReorderList({ items, onMove, disabled, className, renderItem, showHint = true, layout = "vertical" }: {
  items: ReorderItem[];
  onMove: (id: string, position: number) => void;
  disabled?: boolean | undefined;
  className?: string;
  renderItem?: (item: ReorderItem, position: number) => ReactNode;
  showHint?: boolean;
  layout?: "vertical" | "wrap";
}): ReactNode {
  const list = useRef<HTMLOListElement>(null);
  const scrollContainer = useRef<HTMLElement | null>(null);
  const gesture = useRef<ReorderGesture | null>(null);
  const [drag, setDrag] = useState<{ id: string; target: number; offsets: Record<string, { x: number; y: number }> } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const move = (item: ReorderItem, position: number) => {
    onMove(item.id, position);
    setAnnouncement(`${item.label} moved to position ${position + 1} of ${items.length}`);
  };
  return (
    <>
      {showHint && <p className="qt-reorder-hint qt-muted">Drag handles to reorder.</p>}
      <ol ref={list} className={`qt-reorder-list${className ? ` ${className}` : ""}`}>
        {items.map((item, position) => (
          <li key={item.id} data-reorder-id={item.id} style={drag ? { transform: layout === "wrap" ? `translate(${drag.offsets[item.id]?.x ?? 0}px, ${drag.offsets[item.id]?.y ?? 0}px)` : `translateY(${drag.offsets[item.id]?.y ?? 0}px)` } : undefined} className={drag?.id === item.id ? "qt-reorder-item qt-reorder-item--dragging" : "qt-reorder-item"}>
            <button
              type="button"
              className="qt-reorder-handle"
              disabled={disabled}
              aria-label={`Drag to reorder ${item.label}`}
              onPointerDown={(event) => {
                if (event.button !== 0 || disabled) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("li") ?? []);
                const positions = rows.map((row, index) => {
                  const bounds = row.getBoundingClientRect();
                  const next = rows[index + 1]?.getBoundingClientRect();
                  const advance = next ? next.top - bounds.top : bounds.height + (parseFloat(getComputedStyle(row).marginBottom) || 0);
                  return { id: row.dataset.reorderId!, top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height, advance };
                });
                let scroller: HTMLElement | null = list.current;
                while (scroller && (!/auto|scroll/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight)) scroller = scroller.parentElement;
                scrollContainer.current = scroller ?? document.scrollingElement as HTMLElement | null;
                gesture.current = { id: item.id, position, target: position, layout: positions, scrollTop: scrollContainer.current?.scrollTop ?? 0 };
                setDrag({ id: item.id, target: position, offsets: {} });
              }}
              onPointerMove={(event) => {
                const current = gesture.current;
                if (!current) return;
                const scrollDelta = (scrollContainer.current?.scrollTop ?? 0) - current.scrollTop;
                let target = current.layout.findIndex((row) => event.clientY < row.top + row.advance - scrollDelta);
                if (layout === "wrap") {
                  let nearest = Infinity;
                  current.layout.forEach((row, index) => {
                    const distanceX = Math.max(row.left - event.clientX, 0, event.clientX - row.left - row.width);
                    const distanceY = Math.max(row.top - scrollDelta - event.clientY, 0, event.clientY - row.top + scrollDelta - row.height);
                    const distance = distanceX * distanceX + distanceY * distanceY;
                    if (distance < nearest) {
                      nearest = distance;
                      target = index;
                    }
                  });
                }
                if (target < 0) target = items.length - 1;
                target = Math.max(0, Math.min(target, items.length - 1));
                if (target !== current.target) {
                  current.target = target;
                  const preview = [...current.layout];
                  const [source] = preview.splice(current.position, 1);
                  if (source) preview.splice(target, 0, source);
                  let top = current.layout[0]?.top ?? 0;
                  let left = list.current?.getBoundingClientRect().left ?? 0;
                  const firstLeft = left;
                  const right = list.current?.getBoundingClientRect().right ?? Infinity;
                  const style = list.current ? getComputedStyle(list.current) : null;
                  const columnGap = parseFloat(style?.columnGap ?? "0") || 0;
                  const rowGap = parseFloat(style?.rowGap ?? "0") || 0;
                  let rowHeight = 0;
                  const offsets: Record<string, { x: number; y: number }> = {};
                  for (const row of preview) {
                    if (layout === "wrap") {
                      if (left > firstLeft && left + row.width > right + 1) {
                        left = firstLeft;
                        top += rowHeight + rowGap;
                        rowHeight = 0;
                      }
                      offsets[row.id] = { x: left - row.left, y: top - row.top };
                      left += row.width + columnGap;
                      rowHeight = Math.max(rowHeight, row.height);
                    } else {
                      offsets[row.id] = { x: 0, y: top - row.top };
                      top += row.advance;
                    }
                  }
                  setDrag({ id: current.id, target, offsets });
                }
                const scroller = scrollContainer.current;
                if (scroller) {
                  const bounds = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
                  if (event.clientY > bounds.bottom - 48) scroller.scrollTop += 16;
                  if (event.clientY < bounds.top + 48) scroller.scrollTop -= 16;
                }
              }}
              onPointerUp={() => {
                const current = gesture.current;
                gesture.current = null;
                setDrag(null);
                if (current && current.position !== current.target) move(item, current.target);
              }}
              onPointerCancel={() => {
                gesture.current = null;
                setDrag(null);
              }}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key === "ArrowUp" || event.key === "ArrowDown" || (layout === "wrap" && (event.key === "ArrowLeft" || event.key === "ArrowRight"))) {
                  event.preventDefault();
                  move(item, Math.max(0, Math.min(items.length - 1, position + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1))));
                }
              }}
            ><Icon name="grip" /></button>
            {renderItem ? renderItem(item, position) : <span className="qt-reorder-label">{item.label}</span>}
          </li>
        ))}
      </ol>
      <span className="qt-sr-only" role="status">{announcement}</span>
    </>
  );
}
