import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useMobileLayout } from "./AdaptiveOverlay";

export function ShareButton({ getUrl, title = "Item details", compact = false }: { getUrl: () => string | Promise<string>; title?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mobile = useMobileLayout();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function share() {
    setBusy(true); setError(null);
    try {
      const url = await getUrl();
      if (mobile && navigator.share) {
        try { await navigator.share({ title, url }); return; }
        catch (error) { if (error instanceof Error && error.name === "AbortError") return; }
      }
      try { await navigator.clipboard.writeText(url); setCopied(true); }
      catch { window.prompt("Copy this item URL", url); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <><button type="button" disabled={busy} className={compact ? "qt-link-btn qt-property-icon-button" : "qt-btn"} title="Share this item and its property view" aria-live="polite" onClick={() => void share()}>
    <Icon name={copied ? "check" : "share"} size={14} /><span className={compact ? "qt-sr-only" : undefined}>{copied ? "Copied!" : "Share"}</span>
  </button>{error && <small role="alert">{error}</small>}</>;
}
