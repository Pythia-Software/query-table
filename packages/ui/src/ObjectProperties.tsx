import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  EMPTY_QUERY,
  readFieldValue,
  readObjectReference,
  objectReferenceKey,
  type FieldDef,
  type FieldSchema,
  type MetricValue,
  type ObjectReference,
  type PropertyFormat,
  type PropertySelection,
  type PropertyViewState,
  type RelationshipAdapter,
} from "@pythia-software/query-table-core";
import { useObjectReferences } from "@pythia-software/query-table-react";
import {
  defaultRenderers,
  resolveRenderer,
  safeLinkHref,
  type RenderRegistry,
} from "./renderers";
import { formatMetricOutput, metricTimestamp } from "./metricFormat";
import { createMetricColorResolver, type MetricTheme } from "./metricColors";
import { Icon } from "./Icon";
import { JsonValueView, JsonViewerModal, type JsonCellProps } from "./JsonCell";
import { inspectJsonValue } from "./jsonValue";
import { renderCellDisplay } from "./cellFormatting";

export interface ObjectPropertiesProps<Row> {
  schema: FieldSchema<Row>;
  row: Row;
  view: PropertyViewState;
  onViewChange?: (view: PropertyViewState) => void;
  renderers?: RenderRegistry<Row>;
  relationships?: RelationshipAdapter;
  onOpenReference?: (reference: ObjectReference) => void;
  /** Explicit projection coverage distinguishes unloaded fields from NULL values. */
  loadedFields?: readonly string[];
  locale?: string;
  theme?: MetricTheme;
  now?: number;
  className?: string;
}

export function formatPropertyValue(
  value: unknown,
  format: PropertyFormat,
  locale?: string,
  now = Date.now(),
): { text: string; error?: string } {
  if (value == null) return { text: "—" };
  try {
    switch (format.kind) {
      case "text":
      case "code":
        return { text: String(value) };
      case "json": {
        const result = inspectJsonValue(value, format, false);
        return { text: result.formatted, ...(result.error ? { error: result.error } : {}) };
      }
      case "boolean":
        if (value !== true && value !== false && value !== 0 && value !== 1)
          throw Error("Expected a boolean.");
        return { text: value ? "Yes" : "No" };
      case "chips":
        return {
          text: Array.isArray(value) ? value.join(", ") : String(value),
        };
      case "chip":
        return { text: (Array.isArray(value) ? value : [value]).map(item => {
          const key = String(item);
          return format.labels && Object.prototype.hasOwnProperty.call(format.labels, key) ? format.labels[key] : key;
        }).join(", ") };
      case "currency": {
        if (typeof value !== "number" || !Number.isFinite(value))
          throw Error("Expected a finite currency amount.");
        return {
          text: new Intl.NumberFormat(locale, {
            style: "currency",
            currency: format.currency,
            ...(format.decimals !== undefined
              ? {
                  minimumFractionDigits: format.decimals,
                  maximumFractionDigits: format.decimals,
                }
              : {}),
          }).format(value),
        };
      }
      case "relative": {
        const { date } = metricTimestamp(value as MetricValue, {
          kind: "datetime",
          sourceUnit: format.sourceUnit ?? "iso",
        });
        const seconds = (date.getTime() - now) / 1000;
        const abs = Math.abs(seconds);
        const [unit, size]: [Intl.RelativeTimeFormatUnit, number] =
          abs < 60
            ? ["second", 1]
            : abs < 3600
              ? ["minute", 60]
              : abs < 86400
                ? ["hour", 3600]
                : abs < 2592000
                  ? ["day", 86400]
                  : abs < 31536000
                    ? ["month", 2592000]
                    : ["year", 31536000];
        return {
          text: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
            Math.round(seconds / size),
            unit,
          ),
        };
      }
      default:
        if (!["string", "number", "boolean"].includes(typeof value))
          throw Error("Expected a scalar value.");
        return formatMetricOutput(
          value as MetricValue,
          format.kind === "number" && format.decimals === undefined
            ? undefined
            : format,
          locale,
        );
    }
  } catch (error) {
    return {
      text: String(value),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultFormat(field: FieldDef): PropertyFormat | undefined {
  if (field.render === "duration_ms")
    return { kind: "duration", sourceUnit: "milliseconds", style: "human" };
  if (field.render === "datetime_rel") return { kind: "relative" };
  if (field.type === "datetime") return { kind: "datetime", timeZone: "local" };
  if (field.type === "bool") return { kind: "boolean" };
  if (field.type === "enum" || field.type === "textarray")
    return { kind: "chips" };
  if (field.type === "number") return { kind: "number" };
  return { kind: "text" };
}

function propertyContent<Row>(
  field: FieldDef<Row>,
  property: PropertySelection,
  value: unknown,
  props: ObjectPropertiesProps<Row>,
  now: number,
): ReactNode {
  const registry = {
    ...defaultRenderers,
    ...props.renderers,
  } as RenderRegistry<Row>;
  const explicitRenderer =
    property.render ?? (!property.format ? field.property?.render : undefined);
  const format =
    property.format ?? (!explicitRenderer ? field.property?.format : undefined);
  if (explicitRenderer) {
    if (!registry[explicitRenderer])
      return (
        <span className="qt-property-unavailable">
          Renderer unavailable: {explicitRenderer}
        </span>
      );
    return registry[explicitRenderer]!({
      value,
      row: props.row,
      field,
      query: EMPTY_QUERY,
      presentation: "property",
    });
  }
  // Preserve host renderers, but avoid table truncation and short date strings.
  if (
    !format &&
    field.render &&
    ![
      "text",
      "truncate",
      "number",
      "datetime",
      "datetime_rel",
      "duration_ms",
      "bool_check",
      "tags_pills",
    ].includes(String(field.render))
  )
    return resolveRenderer(
      field,
      registry,
    )({ value, row: props.row, field, query: EMPTY_QUERY, presentation: "property" });
  // A single field display supplies the default in both table cells and item
  // properties. A saved appearance or detail-specific renderer/format still wins.
  if (!format && field.display) return renderCellDisplay(
    { value, row: props.row, field, query: EMPTY_QUERY, presentation: "property" }, field.display,
  );
  const effective = format ?? defaultFormat(field)!;
  if (value == null) return <span className="qt-muted">—</span>;
  if (effective.kind === "json") return <JsonValueView value={value} label={property.label ?? field.label} display={effective} />;
  if (effective.kind === "chip") return renderCellDisplay(
    { value, row: props.row, field, query: EMPTY_QUERY, presentation: "property" }, effective,
  );
  if (effective.kind === "chips") {
    const values = Array.isArray(value) ? value : [value];
    const colors = createMetricColorResolver(props.theme);
    const options =
      field.filter?.values?.source === "static"
        ? field.filter.values.options
        : [];
    return (
      <span className="qt-property-chips">
        {values.map((item, index) => {
          const option = options.find((option) =>
            typeof option === "string"
              ? option === String(item)
              : option.value === String(item),
          );
          const label =
            typeof option === "object" ? option.label : String(item);
          return (
            <span
              key={index}
              className="qt-property-chip"
              style={{
                "--qt-property-chip-color": colors.color(field.name, item as MetricValue),
              } as CSSProperties}
            >
              {label}
            </span>
          );
        })}
      </span>
    );
  }
  const output = formatPropertyValue(value, effective, props.locale, now);
  const content =
    effective.kind === "code" ? (
      <pre className="qt-property-code">{output.text}</pre>
    ) : (
      <span>{output.text}</span>
    );
  return (
    <span
      title={
        output.error ??
        (effective.kind === "relative" ? String(value) : undefined)
      }
    >
      {content}
      {output.error ? (
        <span role="status" className="qt-property-unavailable">
          {" "}
          · {output.error}
        </span>
      ) : null}
    </span>
  );
}

export function ObjectProperties<Row>(
  props: ObjectPropertiesProps<Row>,
): ReactNode {
  const { schema, row, view, loadedFields } = props;
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ left: number; width: number; value: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const [jsonViewer, setJsonViewer] = useState<{ props: JsonCellProps; trigger: HTMLElement } | null>(null);
  useEffect(() => { setCopied(null); setCopyError(""); }, [row]);
  useEffect(() => { setJsonViewer(null); }, [row]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const labelWidth = view.labelWidth ?? 28;
  const setLabelWidth = (value?: number) => {
    const next = { ...view };
    if (value === undefined) delete next.labelWidth;
    else next.labelWidth = Math.max(15, Math.min(75, Math.round(value)));
    props.onViewChange?.(next);
  };
  function fitLabels() {
    const element = surface.current;
    if (!element) return;
    const labels = Array.from(element.querySelectorAll<HTMLElement>("dt"));
    const probes = labels.map(label => {
      const probe = document.createElement("span");
      probe.textContent = label.textContent;
      probe.style.cssText = "position:absolute;width:max-content;white-space:nowrap;visibility:hidden;";
      label.appendChild(probe);
      return probe;
    });
    const widest = Math.max(60, ...probes.map(probe => probe.getBoundingClientRect().width + 32));
    probes.forEach(probe => probe.remove());
    setLabelWidth(100 * widest / element.getBoundingClientRect().width);
  }
  async function copyValue(id: string, value: unknown) {
    setCopyError("");
    try {
      const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch { setCopyError("Could not copy. Select the value and copy it manually."); }
  }
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (props.now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [props.now]);
  const now = props.now ?? clock;
  const coverage = loadedFields ? new Set(loadedFields) : null;
  const entries = view.properties.map((property) => ({
    property,
    field: schema.fields.find((field) => field.name === property.field),
  }));
  const references = useMemo(
    () =>
      entries.flatMap(({ field }) => {
        if (!field || field.property?.enabled === false) return [];
        if (
          coverage &&
          field.relationship &&
          Object.values(field.relationship.key).some(
            (name) => !coverage.has(name),
          )
        )
          return [];
        const reference = readObjectReference(field, schema.fields, row);
        return reference ? [reference] : [];
      }),
    [schema, row, view, loadedFields],
  );
  const resolved = useObjectReferences(references, props.relationships);
  return (
    <div ref={surface} className={`qt-object-properties ${props.className ?? ""}`} style={view.labelWidth !== undefined ? { "--qt-property-label-width": `${labelWidth}%` } as CSSProperties : undefined}>
      <div className="qt-property-columns">
        <span>Property{props.onViewChange && <span className="qt-resize-handle" role="separator" aria-orientation="vertical"
          aria-label="Resize property column" aria-valuenow={labelWidth} aria-valuemin={15} aria-valuemax={75} tabIndex={0}
          title="Drag to resize. Enter fits labels; double click resets."
          onPointerDown={event => {
            event.preventDefault();
            const rect = surface.current!.getBoundingClientRect();
            drag.current = { left: rect.left, width: rect.width, value: labelWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (!drag.current) return;
            drag.current.value = Math.max(15, Math.min(75, 100 * (event.clientX - drag.current.left) / drag.current.width));
            surface.current?.style.setProperty("--qt-property-label-width", `${drag.current.value}%`);
          }}
          onPointerUp={event => {
            if (!drag.current) return;
            const value = drag.current.value;
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            setLabelWidth(value);
          }}
          onPointerCancel={() => { drag.current = null; surface.current?.style.setProperty("--qt-property-label-width", `${labelWidth}%`); }}
          onDoubleClick={() => setLabelWidth()}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Enter", "Home"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Enter") fitLabels();
            else if (event.key === "Home") setLabelWidth();
            else setLabelWidth(labelWidth + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 10 : 2));
          }}
        />}</span><span>Value</span>
      </div>
      {view.properties.length === 0 ? (
        <p className="qt-muted">No properties selected.</p>
      ) : null}
      <dl className="qt-property-list">
        {entries.map(({ property, field }) => {
          let content: ReactNode;
          let available = false;
          let rawValue: unknown;
          let jsonProps: JsonCellProps | undefined;
          if (!field || field.property?.enabled === false)
            content = (
              <span className="qt-property-unavailable">Field unavailable</span>
            );
          else if (
            coverage &&
            !coverage.has(field.name) &&
            !(
              field.source.kind === "derived" &&
              field.source.dependencies?.every((name) => coverage.has(name))
            )
          )
            content = (
              <span className="qt-property-unavailable">Not loaded</span>
            );
          else {
            const value = readFieldValue(field, row);
            rawValue = value;
            available = true;
            const reference = readObjectReference(field, schema.fields, row);
            const result = reference
              ? resolved.values.get(objectReferenceKey(reference))
              : undefined;
            const href = result?.href ? safeLinkHref(result.href) : null;
            let display =
              result?.label ??
              propertyContent(field, property, value, props, now);
            if (isValidElement<JsonCellProps & { compact?: boolean }>(display) && display.type === JsonValueView) {
              if (value != null && value !== "") jsonProps = { ...display.props, label: property.label ?? field.label };
              display = cloneElement(display, { compact: true });
            }
            content = href ? (
              <a
                className="qt-link qt-property-reference"
                href={href}
                onClick={
                  props.onOpenReference && reference
                    ? (event) => {
                        event.preventDefault();
                        props.onOpenReference!(reference);
                      }
                    : undefined
                }
              >
                <Icon name="panelReference" size={14} /><span>{display}</span><Icon name="arrowRight" size={13} />
              </a>
            ) : reference && props.onOpenReference ? (
              <button
                className="qt-property-link qt-property-reference"
                type="button"
                onClick={() => props.onOpenReference!(reference)}
              >
                <Icon name="panelReference" size={14} /><span>{display}</span><Icon name="arrowRight" size={13} />
              </button>
            ) : (
              display
            );
          }
          return (
            <div className="qt-property" key={property.id} data-property-type={field?.type}>
              <dt><span>{property.label ?? field?.label ?? property.field}</span>{jsonProps && <button type="button" className="qt-link-btn qt-property-json-open"
                aria-label={`Open ${property.label ?? field?.label ?? property.field} in JSON Viewer`} title="Open in JSON Viewer"
                onClick={(event) => setJsonViewer({ props: jsonProps!, trigger: event.currentTarget })}><Icon name="panelDefinition" size={14} /></button>}</dt>
              <dd tabIndex={available ? 0 : undefined} title={available ? "Double click or press Enter to copy the value" : undefined}
                onDoubleClick={event => {
                  if (!available || (event.target as HTMLElement).closest("a, button, input, textarea, select, [contenteditable]")) return;
                  event.preventDefault();
                  void copyValue(property.id, rawValue);
                }}
                onKeyDown={event => {
                  if (available && event.target === event.currentTarget && (event.key === "Enter" || ((event.ctrlKey || event.metaKey) && event.key === "c" && !window.getSelection()?.toString()))) {
                    event.preventDefault();
                    void copyValue(property.id, rawValue);
                  }
                }}>
                {content}{copied === property.id && <span className="qt-property-copy-feedback" role="status"><Icon name="check" size={13} />Copied</span>}
              </dd>
            </div>
          );
        })}
      </dl>
      {jsonViewer && <JsonViewerModal {...jsonViewer.props} onClose={() => setJsonViewer(null)} returnFocus={jsonViewer.trigger} />}
      {copyError && <p className="qt-property-copy-error" role="status">{copyError}</p>}
      {resolved.error ? (
        <p role="status" className="qt-property-unavailable">
          Relationship labels unavailable: {resolved.error.message}
        </p>
      ) : null}
    </div>
  );
}
