import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type Dispatch, type KeyboardEvent,
  type ReactNode, type SetStateAction,
} from "react";
import {
  autoUpdate, flip, FloatingNode, FloatingTree, offset, safePolygon, shift, size,
  useFloating, useFloatingNodeId, useHover, useInteractions,
} from "@floating-ui/react";
import { Icon } from "./Icon";
import type { MenuClassNames } from "./classNames";
import { useIsomorphicLayoutEffect } from "./overlayTheme";
import { OverlayPortal, useFloatingOverlay, type OverlayAnchor, type OverlayCloseReason } from "./FloatingOverlay";

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
type CloseReason = OverlayCloseReason;

/** A trigger element, or viewport coordinates for a context menu. */
export type MenuAnchor = OverlayAnchor;
export interface MenuProps {
  label: string;
  anchor: MenuAnchor;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  initialFocus?: "first" | "last";
  classNames?: MenuClassNames | undefined;
  /** Focus destination after selection or Escape (defaults to the trigger/current focus). */
  returnFocus?: HTMLElement | null | undefined;
}

interface RootContextValue {
  close: (reason: CloseReason) => void;
  mobile: boolean;
  rtl: boolean;
  classNames: MenuClassNames | undefined;
}
interface PanelContextValue {
  openChild: string | null;
  setOpenChild: Dispatch<SetStateAction<string | null>>;
}
const RootContext = createContext<RootContextValue | null>(null);
const PanelContext = createContext<PanelContextValue | null>(null);
function useMenuRoot() {
  const root = useContext(RootContext);
  if (!root) throw new Error("Menu items must be rendered inside a Menu.");
  return root;
}

/** Mounted while open. Desktop menus escape clipping; phones use the shared sheet. */
export function Menu(props: MenuProps): ReactNode {
  return <FloatingTree><MenuRoot {...props} /></FloatingTree>;
}

function MenuRoot({ label, anchor, onClose, children, width = 240, classNames, returnFocus, initialFocus = "first" }: MenuProps) {
  const nodeId = useFloatingNodeId();
  const overlay = useFloatingOverlay({ anchor, onClose, returnFocus, width, nodeId });
  const { close, mobile, rtl, isPositioned } = overlay;
  const panel = (
    <FloatingNode id={nodeId}>
      <RootContext.Provider value={{ close, mobile, rtl, classNames }}>
        <MenuPanel
          ref={overlay.setSurface}
          label={label}
          className={cx("qt-cell-menu", classNames?.popover)}
          style={overlay.style}
          autoFocus={!mobile && isPositioned}
          initialFocus={initialFocus}
          onBack={() => close("escape")}
        >{children}</MenuPanel>
      </RootContext.Provider>
    </FloatingNode>
  );
  return <OverlayPortal overlay={overlay} label={label}>{panel}</OverlayPortal>;
}

function enabledItems(panel: HTMLElement): HTMLButtonElement[] {
  return Array.from(panel.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR))
    .filter((item) => item.closest('[role="menu"]') === panel && !item.disabled && item.getAttribute("aria-disabled") !== "true");
}
function focusItem(panel: HTMLElement, item: HTMLElement | undefined) {
  if (!item) return;
  enabledItems(panel).forEach((candidate) => { candidate.tabIndex = candidate === item ? 0 : -1; });
  item.focus({ preventScroll: true });
  item.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}
function firstItem(panel: HTMLElement | null, last = false) {
  if (panel) {
    const items = enabledItems(panel);
    const item = last ? items[items.length - 1] : items[0];
    if (item) focusItem(panel, item);
    else panel.focus({ preventScroll: true });
  }
}

interface PanelProps {
  label: string;
  className: string;
  style?: CSSProperties | undefined;
  autoFocus?: boolean;
  initialFocus?: "first" | "last";
  onBack: () => void;
  children: ReactNode;
  floatingProps?: Record<string, unknown>;
}
const MenuPanel = forwardRef<HTMLDivElement, PanelProps>(function MenuPanel(
  { label, className, style, autoFocus = false, initialFocus = "first", onBack, children, floatingProps }, forwardedRef,
) {
  const root = useMenuRoot();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const search = useRef({ text: "", time: 0 });
  useIsomorphicLayoutEffect(() => {
    const panel = elementRef.current;
    if (!panel) return;
    const items = enabledItems(panel);
    const focused = items.find((item) => item === document.activeElement) ?? items[0];
    items.forEach((item) => { item.tabIndex = root.mobile || item === focused ? 0 : -1; });
  });
  useIsomorphicLayoutEffect(() => {
    if (autoFocus) firstItem(elementRef.current, initialFocus === "last");
  }, [autoFocus, initialFocus]);

  const setPanelElement = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = event.currentTarget;
    if ((event.target as Element).closest('[role="menu"]') !== panel || event.defaultPrevented) return;
    const items = enabledItems(panel);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const backKey = root.rtl ? "ArrowRight" : "ArrowLeft";
    if (event.key === "Escape" || (event.key === backKey && panel.classList.contains("qt-cm-submenu"))) {
      event.preventDefault(); event.stopPropagation(); onBack(); return;
    }
    if (event.key === "Tab") {
      if (!root.mobile) root.close("tab");
      return;
    }
    const group = (event.target as Element).closest<HTMLElement>('[data-qt-menu-columns]');
    const columns = Number(group?.dataset.qtMenuColumns ?? 1);
    if (group && columns > 1 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const members = Array.from(group.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR)).filter(item => item.closest('[role="menu"]') === panel);
      const at = members.indexOf(document.activeElement as HTMLButtonElement);
      const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
      const delta = vertical ? (event.key === "ArrowDown" ? columns : -columns) :
        (event.key === (root.rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1);
      let target = at + delta;
      while (target >= 0 && target < members.length && !items.includes(members[target]!)) target += delta;
      const withinRow = vertical || Math.floor(target / columns) === Math.floor(at / columns);
      if (withinRow && members[target] && items.includes(members[target]!)) focusItem(panel, members[target]);
      else if (vertical) {
        const enabledMembers = members.filter(member => items.includes(member));
        const boundary = items.indexOf(delta > 0 ? enabledMembers[enabledMembers.length - 1]! : enabledMembers[0]!);
        focusItem(panel, items[(boundary + (delta > 0 ? 1 : -1) + items.length) % items.length]);
      }
      setOpenChild(null); search.current.text = "";
      event.preventDefault(); event.stopPropagation(); return;
    }
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    if (event.key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault(); event.stopPropagation();
      setOpenChild(null); search.current.text = "";
      focusItem(panel, items[next]);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing || event.key === " ") return;
    const now = Date.now();
    search.current.text = now - search.current.time < 700 ? search.current.text + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase();
    search.current.time = now;
    const repeated = Array.from(search.current.text).every((letter) => letter === search.current.text[0]);
    const term = repeated ? search.current.text[0]! : search.current.text;
    const candidates = [...items.slice(current + 1), ...items.slice(0, current + 1)];
    const match = candidates.find((item) => (item.dataset.qtMenuLabel ?? item.textContent ?? "").trim().toLocaleLowerCase().startsWith(term));
    if (match) { event.preventDefault(); setOpenChild(null); focusItem(panel, match); }
  };
  return <PanelContext.Provider value={{ openChild, setOpenChild }}>
    <div
      {...floatingProps}
      ref={setPanelElement}
      className={cx("qt-menu-surface", className)} style={style}
      role="menu" aria-label={label} aria-orientation="vertical" tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocusCapture={(event) => {
        const panel = event.currentTarget;
        const target = event.target as HTMLElement;
        if (target.closest('[role="menu"]') === panel && target.matches(ITEM_SELECTOR)) {
          enabledItems(panel).forEach((item) => { item.tabIndex = root.mobile || item === target ? 0 : -1; });
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >{children}</div>
  </PanelContext.Provider>;
});

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onSelect"> {
  onSelect?: (() => void) | undefined;
  closeOnSelect?: boolean;
  checked?: boolean | undefined;
  selectionType?: "checkbox" | "radio";
  icon?: ReactNode;
  shortcut?: string;
  tone?: "default" | "danger";
  /** Typeahead label for rich content (defaults to visible text). */
  textValue?: string;
}
export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { children, onSelect, closeOnSelect = true, checked, selectionType = "checkbox", icon, shortcut, tone = "default", textValue, className, onPointerMove, ...props }, ref,
) {
  const root = useMenuRoot();
  const disabled = props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return <button
    {...props} disabled={disabled} ref={ref} type="button" tabIndex={-1}
    className={cx("qt-cm-item", tone === "danger" && "qt-menu-item--danger", root.classNames?.item, className)}
    role={checked === undefined ? "menuitem" : selectionType === "radio" ? "menuitemradio" : "menuitemcheckbox"}
    aria-checked={checked} data-qt-menu-label={textValue}
    onClick={() => { onSelect?.(); if (closeOnSelect) root.close("select"); }}
    onPointerMove={(event) => {
      onPointerMove?.(event);
      if (event.pointerType === "mouse" && !event.currentTarget.disabled) event.currentTarget.focus({ preventScroll: true });
    }}
  >
    {checked !== undefined || icon ? <span className="qt-menu-item-icon">{checked === undefined ? icon : checked && <Icon name="check" />}</span> : null}
    <span className="qt-menu-item-label">{children}</span>
    {shortcut && <span className="qt-menu-shortcut" aria-hidden="true">{shortcut}</span>}
  </button>;
});

export interface MenuSubmenuProps {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  width?: number;
}
export function MenuSubmenu({ label, children, disabled = false, width = 220 }: MenuSubmenuProps): ReactNode {
  const root = useMenuRoot();
  const parent = useContext(PanelContext);
  if (!parent) throw new Error("MenuSubmenu must be rendered inside a Menu.");
  const id = useId();
  const nodeId = useFloatingNodeId();
  const open = parent.openChild === id && !disabled;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);
  const setOpen = (next: boolean) => {
    // Hover dismissal can remove the focused child; keep keyboard navigation in
    // the surviving parent instead of leaving focus on the document body.
    if (!next && panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    parent.setOpenChild((previous) => next ? id : previous === id ? null : previous);
  };
  const { refs, floatingStyles, context, placement, isPositioned } = useFloating({
    nodeId, open, onOpenChange: setOpen, strategy: "fixed", transform: false,
    placement: root.rtl ? "left-start" : "right-start", whileElementsMounted: autoUpdate,
    middleware: [offset({ mainAxis: 5, alignmentAxis: -5 }), flip({ padding: 8 }), shift({ padding: 8 }), size({
      padding: 8,
      apply({ availableHeight, elements }) { elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`; },
    })],
  });
  const hover = useHover(context, {
    enabled: !root.mobile && !disabled, mouseOnly: true,
    delay: { open: 75, close: 150 }, handleClose: safePolygon({ requireIntent: false }),
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);
  useIsomorphicLayoutEffect(() => {
    if (open && (isPositioned || root.mobile) && focusOnOpen.current) { focusOnOpen.current = false; firstItem(panel.current); }
  }, [open, isPositioned, root.mobile]);
  useEffect(() => { if (disabled && parent.openChild === id) setOpen(false); }, [disabled]);
  const openWithFocus = () => {
    focusOnOpen.current = true;
    if (open) { focusOnOpen.current = false; firstItem(panel.current); }
    else setOpen(true);
  };
  const setTriggerElement = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
    refs.setReference(element);
  }, [refs.setReference]);
  const setSubmenuElement = useCallback((element: HTMLDivElement | null) => {
    panel.current = element;
    refs.setFloating(root.mobile ? null : element);
    if (element) element.id = id;
  }, [refs.setFloating, root.mobile, id]);
  return <FloatingNode id={nodeId}>
    <div className="qt-cm-submenu-wrap">
      <MenuItem
        {...getReferenceProps()}
        ref={setTriggerElement}
        className={cx("qt-cm-submenu-trigger", open && "qt-cm-item--open")}
        disabled={disabled} closeOnSelect={false}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onSelect={() => root.mobile ? setOpen(!open) : openWithFocus()}
        onKeyDown={(event) => {
          if (event.key === (root.rtl ? "ArrowLeft" : "ArrowRight")) {
            event.preventDefault(); event.stopPropagation(); openWithFocus();
          } else if (open && (event.key === "Escape" || event.key === (root.rtl ? "ArrowRight" : "ArrowLeft"))) {
            event.preventDefault(); event.stopPropagation(); setOpen(false);
          }
        }}
      >{label}<Icon name={root.mobile && open ? "chevronDown" : "chevronRight"} className={root.rtl && !root.mobile ? "qt-menu-caret--rtl" : ""} /></MenuItem>
      {open && <MenuPanel
        ref={setSubmenuElement}
        label={label}
        className={cx("qt-cm-submenu", placement.startsWith("left") && "qt-cm-submenu--left", root.classNames?.submenu)}
        style={root.mobile ? undefined : { ...floatingStyles, width, maxWidth: "calc(100vw - 16px)", visibility: isPositioned ? "visible" : "hidden" }}
        floatingProps={getFloatingProps()}
        onBack={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}
      >{children}</MenuPanel>}
    </div>
  </FloatingNode>;
}

export function MenuSeparator(): ReactNode {
  const root = useMenuRoot();
  return <div className={cx("qt-cm-sep", root.classNames?.separator)} role="separator" />;
}

export interface MenuGroupProps {
  label: string;
  children: ReactNode;
  className?: string;
  /** Column count for paired action grids; arrows follow rows and columns. */
  columns?: number;
}

export interface MenuButtonProps extends Omit<MenuProps, "anchor" | "onClose" | "returnFocus" | "initialFocus"> {
  trigger: ReactNode;
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onKeyDown" | "children" | "type">;
}
/** Uncontrolled action trigger, including ArrowUp/Down opening and focus return. */
export function MenuButton({ trigger, buttonProps, ...menuProps }: MenuButtonProps): ReactNode {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  return <>
    <button {...buttonProps} type="button" aria-label={buttonProps?.["aria-label"] ?? menuProps.label} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={event => { const element = event.currentTarget; setInitialFocus("first"); setAnchor(previous => previous ? null : element); }}
      onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); setInitialFocus(event.key === "ArrowUp" ? "last" : "first"); setAnchor(event.currentTarget);
      }}
    >{trigger}</button>
    {anchor && <Menu {...menuProps} anchor={anchor} initialFocus={initialFocus} onClose={() => setAnchor(null)} />}
  </>;
}
export function MenuGroup({ label, children, className, columns = 1 }: MenuGroupProps): ReactNode {
  useMenuRoot();
  const count = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  return <div role="group" aria-label={label} className={cx("qt-menu-group", className)} data-qt-menu-columns={count}
    style={count > 1 ? { display: "grid", gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` } : undefined}>{children}</div>;
}
