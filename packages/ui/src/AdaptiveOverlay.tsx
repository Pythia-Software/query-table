import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const MOBILE_QUERY =
  "(max-width: 760px), (pointer: coarse) and (max-height: 500px)";
const modalStack: HTMLElement[] = [];
let originalOverflow = "";

function subscribeMobile(listener: () => void) {
  const media = window.matchMedia?.(MOBILE_QUERY);
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia?.(MOBILE_QUERY).matches ?? false,
    () => false,
  );
}

export function ModalSurface({
  title,
  onClose,
  children,
  className = "qt-modal",
  chrome = true,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
  chrome?: boolean;
}): ReactNode {
  const mobile = useMobileLayout();
  const titleId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const themeAnchor = useRef<HTMLSpanElement>(null);
  const [theme, setTheme] = useState<Record<string, string>>({});
  const close = useRef(onClose);
  close.current = onClose;
  const swipeStart = useRef<number | null>(null);
  const [swipeDistance, setSwipeDistance] = useState(0);
  const [viewport, setViewport] = useState<{
    top: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!mobile || !themeAnchor.current) return;
    const styles = getComputedStyle(themeAnchor.current);
    const inherited: Record<string, string> = { fontFamily: styles.fontFamily };
    for (const property of Array.from(styles)) {
      if (property.startsWith("--qt-"))
        inherited[property] = styles.getPropertyValue(property);
    }
    setTheme(inherited);
  }, [mobile]);

  useEffect(() => {
    if (!mobile || !window.visualViewport) return;
    const visualViewport = window.visualViewport;
    const update = () =>
      setViewport({
        top: visualViewport.offsetTop,
        height: visualViewport.height,
      });
    update();
    visualViewport.addEventListener("resize", update);
    visualViewport.addEventListener("scroll", update);
    return () => {
      visualViewport.removeEventListener("resize", update);
      visualViewport.removeEventListener("scroll", update);
    };
  }, [mobile]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (modalStack.length === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    modalStack.push(element);
    element.focus();
    const isTop = () => modalStack[modalStack.length - 1] === element;
    const focusable = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"], [contenteditable="true"]',
        ),
      ).filter((target) => {
        if (target.closest('[hidden], [inert], [aria-hidden="true"]'))
          return false;
        for (
          let parent: HTMLElement | null = target.parentElement;
          parent && parent !== element;
          parent = parent.parentElement
        ) {
          if (
            parent instanceof HTMLDetailsElement &&
            !parent.open &&
            !parent.querySelector(":scope > summary")?.contains(target)
          )
            return false;
        }
        let ancestor: HTMLElement | null = target;
        while (ancestor && ancestor !== element) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility === "hidden")
            return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    const onKey = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented) return;
      if (
        event.key === "Escape" &&
        !element.querySelector("[data-qt-formula-suggestions]")
      ) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const targets = focusable();
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first) {
        event.preventDefault();
        element.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === element)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && !element.contains(event.target as Node)) element.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      modalStack.splice(modalStack.indexOf(element), 1);
      if (modalStack.length === 0)
        document.body.style.overflow = originalOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [mobile]);

  const content = (
    <div
      className={`qt-modal-backdrop qt-overlay-backdrop${mobile ? " qt-overlay-backdrop--mobile" : ""}`}
      style={
        mobile
          ? {
              ...theme,
              ...(viewport
                ? { top: viewport.top, height: viewport.height, bottom: "auto" }
                : {}),
            }
          : undefined
      }
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={surface}
        className={`${className} qt-modal-surface${mobile ? " qt-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={chrome ? titleId : undefined}
        aria-label={chrome ? undefined : title}
        tabIndex={-1}
        style={
          swipeDistance
            ? { transform: `translateY(${swipeDistance}px)` }
            : undefined
        }
      >
        {mobile && (
          <div
            className="qt-sheet-handle"
            aria-hidden="true"
            onPointerDown={(event) => {
              swipeStart.current = event.clientY;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (swipeStart.current !== null)
                setSwipeDistance(
                  Math.max(0, event.clientY - swipeStart.current),
                );
            }}
            onPointerUp={(event) => {
              const distance =
                swipeStart.current === null
                  ? 0
                  : event.clientY - swipeStart.current;
              swipeStart.current = null;
              setSwipeDistance(0);
              if (distance > 80) onClose();
            }}
            onPointerCancel={() => {
              swipeStart.current = null;
              setSwipeDistance(0);
            }}
          >
            <span />
          </div>
        )}
        {chrome && (
          <header className="qt-overlay-header">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="qt-btn"
              onClick={onClose}
              aria-label={`Close ${title}`}
            >
              Done
            </button>
          </header>
        )}
        {children}
      </div>
    </div>
  );
  return mobile ? (
    <>
      <span ref={themeAnchor} hidden />
      {createPortal(content, document.body)}
    </>
  ) : (
    content
  );
}

export function AdaptiveOverlay({
  title,
  onClose,
  children,
  enabled = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  enabled?: boolean;
}): ReactNode {
  const mobile = useMobileLayout();
  return mobile && enabled ? (
    <ModalSurface title={title} onClose={onClose}>
      {children}
    </ModalSurface>
  ) : (
    children
  );
}
