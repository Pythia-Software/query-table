import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from "@floating-ui/react";
import { ModalSurface, useMobileLayout } from "./AdaptiveOverlay";
import { useIsomorphicLayoutEffect, useOverlayTheme } from "./overlayTheme";

export type OverlayAnchor = HTMLElement | { x: number; y: number };
export type OverlayCloseReason = "escape" | "select" | "outside" | "tab";
export interface FloatingOverlayOptions {
  anchor: OverlayAnchor;
  onClose: () => void;
  returnFocus?: HTMLElement | null | undefined;
  width?: CSSProperties["width"] | undefined;
  /** Combobox suggestions remain anchored on mobile and keep focus in their input. */
  modalOnMobile?: boolean | undefined;
  retainAnchorFocus?: boolean | undefined;
  maxHeight?: number | undefined;
  placement?: Placement | undefined;
  nodeId?: string | undefined;
}

/** Shared geometry, theme, dismissal and focus lifecycle for menus and forms. */
export function useFloatingOverlay({ anchor, onClose, returnFocus, width = 240, placement = "bottom-start", nodeId, modalOnMobile = true, retainAnchorFocus = false, maxHeight }: FloatingOverlayOptions) {
  const mobileLayout = useMobileLayout();
  const mobile = mobileLayout && modalOnMobile;
  const themeAnchor = useRef<HTMLSpanElement>(null);
  const theme = useOverlayTheme(themeAnchor);
  const surface = useRef<HTMLDivElement | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const closed = useRef(false);
  const close = useCallback((reason: OverlayCloseReason = "escape") => {
    if (closed.current) return;
    closed.current = true;
    if (reason !== "outside" && restoreTarget.current?.isConnected) restoreTarget.current.focus({ preventScroll: true });
    closeCallback.current();
  }, []);
  const { refs, floatingStyles, isPositioned } = useFloating({
    ...(nodeId ? { nodeId } : {}), open: true, strategy: "fixed", transform: false,
    placement, whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), size({
      padding: 8,
      apply({ availableHeight, elements }) { elements.floating.style.maxHeight = `${Math.max(0, Math.min(availableHeight, maxHeight ?? Infinity))}px`; },
    })],
  });
  const isElementAnchor = typeof HTMLElement !== "undefined" && anchor instanceof HTMLElement;
  const pointX = isElementAnchor ? undefined : (anchor as { x: number; y: number }).x;
  const pointY = isElementAnchor ? undefined : (anchor as { x: number; y: number }).y;
  useIsomorphicLayoutEffect(() => {
    const element = themeAnchor.current;
    if (!element) return;
    // Portals stay in the enclosing dialog's focus trap and stacking context.
    setPortalRoot(element.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    restoreTarget.current = returnFocus ?? (isElementAnchor ? anchor as HTMLElement :
      document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return () => {
      // Selection callbacks may unmount an overlay themselves. Restore focus
      // only if it was still inside; outside clicks retain their destination.
      if (!closed.current && surface.current?.contains(document.activeElement) && restoreTarget.current?.isConnected)
        restoreTarget.current.focus({ preventScroll: true });
    };
  }, []);
  useIsomorphicLayoutEffect(() => {
    refs.setPositionReference(isElementAnchor ? anchor as HTMLElement : {
      getBoundingClientRect: () => ({ x: pointX!, y: pointY!, left: pointX!, top: pointY!,
        right: pointX!, bottom: pointY!, width: 0, height: 0 }),
      ...(themeAnchor.current ? { contextElement: themeAnchor.current } : {}),
    });
  }, [anchor, isElementAnchor, pointX, pointY, refs.setPositionReference]);
  useEffect(() => {
    if (mobile) return;
    let pointerOnAnchor = false;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || surface.current?.contains(event.target)) return;
      // Let the trigger's own click toggle the overlay, including pointerless
      // clicks from assistive technology; don't close and reopen in one event.
      if (isElementAnchor && (anchor as HTMLElement).contains(event.target)) {
        pointerOnAnchor = event.type === "pointerdown";
        return;
      }
      close("outside");
    };
    const focusOutside = (event: FocusEvent) => {
      if ((pointerOnAnchor || retainAnchorFocus) && event.target instanceof Node && isElementAnchor && (anchor as HTMLElement).contains(event.target)) return;
      if (event.target instanceof Node && !surface.current?.contains(event.target)) close("outside");
    };
    const scroll = (event: Event) => {
      if (!isElementAnchor && event.target instanceof Node && !surface.current?.contains(event.target)) close("outside");
    };
    const blur = () => close("outside");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", outside, true);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("click", outside, true);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", blur);
    };
  }, [close, mobile, isElementAnchor, anchor, retainAnchorFocus]);
  const setSurface = useCallback((element: HTMLDivElement | null) => {
    surface.current = element;
    refs.setFloating(mobile ? null : element);
  }, [mobile, refs.setFloating]);
  const style: CSSProperties | undefined = mobile ? undefined : {
    ...theme, ...floatingStyles, width, maxWidth: "calc(100vw - 16px)", visibility: isPositioned ? "visible" : "hidden",
  };
  return { themeAnchor, surface, setSurface, portalRoot, mobile, close, style, isPositioned,
    rtl: theme.direction === "rtl", returnFocus: returnFocus ?? (isElementAnchor ? anchor as HTMLElement : restoreTarget.current) };
}

export function OverlayPortal({ overlay, label, children }: {
  overlay: ReturnType<typeof useFloatingOverlay>; label: string; children: ReactNode;
}) {
  return <>
    <span ref={overlay.themeAnchor} hidden />
    {overlay.mobile ? <ModalSurface title={label} onClose={() => overlay.close("escape")} returnFocus={overlay.returnFocus}>{children}</ModalSurface> :
      overlay.portalRoot ? createPortal(children, overlay.portalRoot) : typeof document === "undefined" ? children : null}
  </>;
}
