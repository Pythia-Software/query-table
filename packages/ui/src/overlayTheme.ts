import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Preserve the host's scoped palette and typography when an overlay portals. */
export function useOverlayTheme(anchor: RefObject<HTMLElement>): CSSProperties {
  const [theme, setTheme] = useState<CSSProperties>({});
  useIsomorphicLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const update = () => {
      const styles = getComputedStyle(element);
      const next: Record<string, string> = {
        fontFamily: styles.fontFamily,
        colorScheme: styles.colorScheme,
        direction: styles.direction,
      };
      for (const property of Array.from(styles)) {
        if (property.startsWith("--qt-")) next[property] = styles.getPropertyValue(property);
      }
      setTheme((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update();
    const observer = new MutationObserver((records) => {
      if (records.some(({ target }) => target instanceof Element && target.contains(element))) update();
    });
    observer.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: ["class", "style", "data-theme", "dir"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);
  return theme;
}
