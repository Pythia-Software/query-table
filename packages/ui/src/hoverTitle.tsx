import type { CSSProperties, MouseEvent, ReactNode } from "react";

// Hover help adds information: a different full label, hidden precision or
// text that CSS clips. It never repeats what is already visible.

/** An element's scroll and client extents, as the DOM reports them. */
export interface ClipBox {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether CSS clips the content: an ellipsis, a line clamp or overflow. */
export function isClipped(box: ClipBox): boolean {
  return box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
}

/** `full` as hover help for `shown` text, unless they are the same. */
export function distinctTitle(full: string | undefined, shown: string): string | undefined {
  return full === undefined || full === shown ? undefined : full;
}

// Digit grouping marks of common locales (comma, apostrophes and spaces).
const GROUPING = /[,'’\s  ]/g;

/**
 * The raw value of a formatted number, unless the formatted text shows it
 * already, at most with digit grouping (`1,234` for `1234`). Rounding, units,
 * percentages and other notation keep the raw value as hover help.
 */
export function numberTitle(raw: string, shown: string): string | undefined {
  return shown === raw || shown.replace(GROUPING, "") === raw ? undefined : raw;
}

/** Offers `full` as an element's title only while the element is clipped. */
export function syncClippedTitle(element: HTMLElement, full: string): void {
  if (isClipped(element)) element.title = full;
  else element.removeAttribute("title");
}

/**
 * Text that offers `title` (default: its own text) as hover help only while
 * CSS clips it. A `title` different from `text` is always offered.
 */
export function ClippedText({
  text,
  title = text,
  className,
  style,
  children,
}: {
  text: string;
  title?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  children?: ReactNode;
}): ReactNode {
  const distinct = distinctTitle(title, text);
  return (
    <span
      className={className}
      style={style}
      title={distinct}
      onMouseEnter={distinct === undefined ? (event: MouseEvent<HTMLElement>) => syncClippedTitle(event.currentTarget, title) : undefined}
    >
      {children ?? text}
    </span>
  );
}
