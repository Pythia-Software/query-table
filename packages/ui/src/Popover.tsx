import type { ReactNode } from "react";
import { OverlayPortal, useFloatingOverlay, type FloatingOverlayOptions } from "./FloatingOverlay";
import { useIsomorphicLayoutEffect } from "./overlayTheme";

export interface PopoverProps extends Omit<FloatingOverlayOptions, "nodeId"> {
  label: string;
  children: ReactNode;
  className?: string;
  /** Desktop focus selector, scoped to this surface (defaults to its first control). */
  initialFocus?: string;
}

/** A form or searchable picker sharing menus' floating and mobile surface. */
export function Popover({ label, children, className, initialFocus, ...options }: PopoverProps) {
  const overlay = useFloatingOverlay(options);
  useIsomorphicLayoutEffect(() => {
    if (overlay.mobile || !overlay.isPositioned) return;
    const panel = overlay.surface.current;
    const control = panel?.querySelector<HTMLElement>(initialFocus ?? 'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]');
    (control ?? panel)?.focus({ preventScroll: true });
  }, [overlay.mobile, overlay.isPositioned, initialFocus]);
  return <OverlayPortal overlay={overlay} label={label}>
    <div ref={overlay.setSurface} className={["qt-menu-surface", "qt-popover", className].filter(Boolean).join(" ")}
      style={overlay.style} role={overlay.mobile ? undefined : "dialog"} aria-label={overlay.mobile ? undefined : label} tabIndex={-1}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation(); overlay.close("escape");
      }}
    >{children}</div>
  </OverlayPortal>;
}
