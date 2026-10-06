import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ColumnPreview } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { ModalSurface } from "./AdaptiveOverlay";
import { Icon } from "./Icon";
import { previewSortExtraction, type SortExtractionResult } from "./sortExtractionPreview";

export function SortExtractionEditor<Row>({ api, field, label, fieldOptions, onFieldChange, title, applyLabel = "Apply extraction", initialPattern, disabled, onApply, onRemove, onClose }: {
  api: QueryTableApi<Row>;
  field: string;
  label: string;
  /** When set, the editor shows a field picker so a new sort can be configured from scratch. */
  fieldOptions?: Array<{ name: string; label: string }> | undefined;
  onFieldChange?: ((field: string) => void) | undefined;
  title?: string | undefined;
  applyLabel?: string | undefined;
  initialPattern?: string | undefined;
  disabled?: boolean | undefined;
  onApply: (pattern: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [pattern, setPattern] = useState(initialPattern ?? "");
  const [sample, setSample] = useState<ColumnPreview | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ pattern: string; sample: ColumnPreview; results: SortExtractionResult[]; error?: string } | null>(null);
  const request = useRef(api.computed.preview);
  request.current = api.computed.preview;
  const inputId = useId();
  const fieldId = useId();
  const helpId = useId();
  const patternError = useMemo(() => {
    try {
      new RegExp(pattern);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid regular expression.";
    }
  }, [pattern]);

  useEffect(() => {
    const controller = new AbortController();
    setSample(null);
    setSampleError(null);
    void request.current(`[${field.replace(/\]/g, "]]")}]`, 100, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSample(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setSampleError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [field]);

  useEffect(() => {
    if (!sample || patternError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void previewSortExtraction(pattern, sample.groups.map((group) => group.result.value), controller.signal).then((results) => {
        if (!controller.signal.aborted) setPreview({ pattern, sample, results });
      }).catch((error) => {
        if (!controller.signal.aborted) setPreview({ pattern, sample, results: [], error: error instanceof Error ? error.message : String(error) });
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pattern, patternError, sample]);

  const currentPreview = preview?.pattern === pattern && preview.sample === sample ? preview : null;
  const error = patternError ?? sampleError ?? currentPreview?.error;
  const ready = Boolean(sample && currentPreview && !error && !sample.errors);
  const heading = title ?? `Regex extraction for ${label}`;
  const textValue = (value: unknown) => value == null ? "NULL" : String(value) === "" ? '""' : String(value);

  return (
    <ModalSurface title={heading} onClose={onClose} className="qt-sort-extract-editor" chrome={false}>
      <header className="qt-overlay-header">
        <h2>{heading}</h2>
        <button type="button" className="qt-btn" onClick={onClose} aria-label={title ? `Close ${title.toLowerCase()}` : `Close regex extraction for ${label}`}><Icon name="close" /></button>
      </header>
      <div className="qt-overlay-body">
        {fieldOptions && (
          <>
            <label className="qt-sort-extract-label" htmlFor={fieldId}>Field</label>
            <select id={fieldId} className="qt-input qt-sort-extract-field" value={field} disabled={disabled} onChange={(event) => onFieldChange?.(event.target.value)}>
              {fieldOptions.map((option) => <option key={option.name} value={option.name}>{option.label}</option>)}
            </select>
          </>
        )}
        <label className="qt-sort-extract-label" htmlFor={inputId}>Regular expression</label>
        <input id={inputId} className="qt-input qt-sort-extract-input" value={pattern} onChange={(event) => setPattern(event.target.value)} aria-label={`Regex extract for ${label}`} aria-describedby={helpId} aria-invalid={Boolean(patternError)} disabled={disabled} autoComplete="off" spellCheck={false} placeholder="e.g. (\d+)" />
        <p id={helpId} className="qt-sort-extract-help">Sort by the first capture group, or the whole match if there are no groups. Unmatched values become NULL; the sort’s null placement still applies.</p>
        {error && <p className="qt-sort-extract-error" role="alert">{error}</p>}
        {Boolean(sample?.errors) && <p className="qt-sort-extract-error" role="alert">Some sampled values could not be read. Resolve those errors before applying extraction.</p>}
        <p className="qt-sort-extract-status" role="status">{!sample && !sampleError ? "Loading sample…" : !currentPreview && !error ? "Updating preview…" : sample ? `Preview of ${sample.processed} matching rows (${sample.groups.length} distinct values).` : "Sample unavailable."}</p>
        <div className="qt-sort-extract-table-wrap">
          <table className="qt-sort-extract-table">
            <caption>Extraction preview</caption>
            <thead><tr><th scope="col">Original value</th><th scope="col">Extracted sort value</th><th scope="col">Rows</th></tr></thead>
            <tbody>{sample?.groups.map((group, index) => {
              const result = currentPreview?.results[index];
              return <tr key={index}><td>{group.result.error ? "Value error" : textValue(group.result.value)}</td><td>{result ? <><code>{textValue(result.extracted)}</code>{!result.matched && <small>{group.result.value == null ? "Null input" : "No match"}</small>}</> : "—"}</td><td>{group.count}</td></tr>;
            })}</tbody>
          </table>
        </div>
        {sample?.processed === 0 && <p className="qt-muted">No matching rows to preview. You can still apply a valid pattern.</p>}
      </div>
      <footer className="qt-sort-extract-footer">
        {initialPattern !== undefined && <button type="button" className="qt-link-btn" disabled={disabled} onClick={onRemove} aria-label={`Remove regex extract for ${label}`}>Remove extraction</button>}
        <button type="button" className="qt-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="qt-btn qt-btn--primary" disabled={disabled || !ready} onClick={() => onApply(pattern)}>{applyLabel}</button>
      </footer>
    </ModalSurface>
  );
}
