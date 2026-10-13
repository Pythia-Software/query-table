import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ModalSurface, useMobileLayout } from "./AdaptiveOverlay";

const Anchor = createContext<RefObject<HTMLSpanElement | null> | null>(null);

/** Keeps a button and its chooser together without inserting an input into the query. */
export function PickerAnchor({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <Anchor.Provider value={anchor}>
      <span ref={anchor} className="qt-picker-anchor">
        {children}
      </span>
    </Anchor.Provider>
  );
}

export function PickerSurface({
  title,
  children,
  onClose,
  mobileChrome = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Editors with their own Apply/Cancel header can keep that chrome on mobile. */
  mobileChrome?: boolean;
}) {
  const anchor = useContext(Anchor);
  const mobile = useMobileLayout();
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const returnFocus = useRef<HTMLElement | null>(null);
  close.current = onClose;
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 440 });
  useLayoutEffect(() => {
    if (mobile) return;
    const element = surface.current;
    if (!element) return;
    const trigger =
      anchor?.current?.querySelector<HTMLButtonElement>(
        'button[aria-expanded="true"]',
      ) ??
      anchor?.current?.querySelector<HTMLButtonElement>("button") ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    returnFocus.current = trigger;
    const update = () => {
      // A standalone picker stays inline; only an explicit PickerAnchor
      // provides floating geometry. Its parent may be an entire modal.
      const rect = anchor?.current?.getBoundingClientRect();
      if (!rect) return;
      const height = Math.min(
        440,
        element.scrollHeight,
        window.innerHeight - 24,
      );
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const flip = below < height && above > below;
      const available = Math.max(120, flip ? above : below);
      setPosition({
        top: flip
          ? Math.max(12, rect.top - Math.min(height, available) - 6)
          : rect.bottom + 6,
        left: Math.max(
          12,
          Math.min(rect.left, window.innerWidth - element.offsetWidth - 12),
        ),
        maxHeight: Math.min(440, available),
      });
    };
    update();
    const observer =
      !anchor || typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !anchor?.current?.contains(event.target)
      )
        close.current();
    };
    const blur = () => close.current();
    element.querySelector<HTMLElement>("input, button")?.focus();
    if (anchor) {
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
    }
    document.addEventListener("pointerdown", dismiss);
    // WebKit can blur an input with no relatedTarget when clicking a button
    // inside the picker. Wait for an actual outside focus destination so the
    // button's click can finish (for example, opening the regex editor).
    document.addEventListener("focusin", dismiss);
    window.addEventListener("blur", blur);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("blur", blur);
      if (
        element.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        trigger?.focus();
    };
  }, [anchor, mobile]);
  if (mobile)
    return (
      <ModalSurface title={title} onClose={onClose} chrome={mobileChrome}>
        {children}
      </ModalSurface>
    );
  return (
    <div
      ref={surface}
      role={anchor ? "dialog" : undefined}
      aria-label={anchor ? title : undefined}
      className={anchor ? "qt-picker-popover" : "qt-picker-inline"}
      style={anchor ? position : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close.current();
          returnFocus.current?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
