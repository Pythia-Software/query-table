import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";

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

/** A locale's digit grouping and decimal marks, as Intl formats them. */
function numberMarks(locale: string | undefined): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    return {
      group: parts.find((part) => part.type === "group")?.value ?? ",",
      decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    };
  } catch {
    return { group: ",", decimal: "." };
  }
}

/**
 * The raw value of a formatted number, unless the formatted text reads as the
 * same number in `locale`: digit grouping (`1,234`, `1.234`) and trailing
 * zeros (`42.00`) add nothing. Rounding, units, percentages and other
 * notation keep the raw value as hover help.
 */
export function numberTitle(raw: string, shown: string, locale?: string): string | undefined {
  if (shown === raw) return undefined;
  const { group, decimal } = numberMarks(locale);
  let plain = shown.replace(/[\s\u00a0\u202f'\u2019]/g, "").split(group).join("");
  if (decimal !== ".") plain = plain.split(decimal).join(".");
  plain = plain.replace(/\u2212/g, "-");
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(plain) && raw.trim() !== "" && Number(plain) === Number(raw) ? undefined : raw;
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
  as: Tag = "span",
  text,
  title = text,
  className,
  style,
  children,
}: {
  as?: "span" | "code";
  text: string;
  title?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  children?: ReactNode;
}): ReactNode {
  const distinct = distinctTitle(title, text);
  const ref = useRef<HTMLElement>(null);
  // A title set on hover describes the previous content once it changes.
  useLayoutEffect(() => {
    if (distinct === undefined) ref.current?.removeAttribute("title");
  }, [text, title, distinct]);
  return (
    <Tag
      ref={ref as never}
      className={className}
      style={style}
      title={distinct}
      onMouseEnter={distinct === undefined ? (event: MouseEvent<HTMLElement>) => syncClippedTitle(event.currentTarget, title) : undefined}
    >
      {children ?? text}
    </Tag>
  );
}
