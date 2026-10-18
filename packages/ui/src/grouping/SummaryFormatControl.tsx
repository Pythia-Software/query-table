import type { CellDisplay } from "@pythia-software/query-table-core";

type NumericKind = "number" | "percent" | "duration";
type DurationUnit = NonNullable<Extract<CellDisplay, { kind: "duration" }>["sourceUnit"]>;
const KINDS: Array<[NumericKind, string]> = [
  ["number", "Number"],
  ["percent", "Percent"],
  ["duration", "Duration"],
];
const UNITS: DurationUnit[] = ["milliseconds", "seconds", "minutes", "hours", "days"];

/** Compact number/percent/duration format for one grouped summary column.
 * Other display kinds set through the API are retained until replaced. */
export function SummaryFormatControl({
  display,
  onChange,
}: {
  display: CellDisplay | undefined;
  onChange: (display: CellDisplay | undefined) => void;
}) {
  const numeric = display && KINDS.some(([kind]) => kind === display.kind)
    ? (display as Extract<CellDisplay, { kind: NumericKind }>)
    : undefined;
  const custom = display && !numeric ? display.kind : undefined;
  const decimals = numeric?.decimals;
  const unit = numeric?.kind === "duration" ? numeric.sourceUnit ?? "milliseconds" : undefined;
  const withDecimals = (next: number | undefined) => {
    if (!numeric) return;
    const { decimals: _previous, ...rest } = numeric;
    onChange(next === undefined ? rest : { ...rest, decimals: next });
  };
  return (
    <div className="qt-column-format" data-column-role="aggregate">
      <div className="qt-column-field-label">Format</div>
      <div className="qt-column-format-controls">
        <select
          className="qt-input"
          aria-label="Column format"
          value={numeric?.kind ?? (custom ? "custom" : "")}
          onChange={(event) => {
            const kind = event.target.value;
            if (kind === "custom") return;
            onChange(kind ? ({ kind, ...(decimals === undefined ? {} : { decimals }) } as CellDisplay) : undefined);
          }}
        >
          <option value="">Default</option>
          {KINDS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          {custom && <option value="custom">Custom ({custom})</option>}
        </select>
        {numeric && (
          <input
            className="qt-input"
            type="number"
            min={0}
            max={20}
            step={1}
            aria-label="Decimal places"
            placeholder="Auto"
            title="Decimal places"
            value={decimals ?? ""}
            onChange={(event) => {
              const value = event.target.value.trim();
              withDecimals(value === "" ? undefined : Math.max(0, Math.min(20, Math.round(Number(value)) || 0)));
            }}
          />
        )}
        {unit && (
          <select
            className="qt-input"
            aria-label="Duration source unit"
            value={unit}
            onChange={(event) => onChange({ ...numeric!, kind: "duration", sourceUnit: event.target.value as DurationUnit })}
          >
            {UNITS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}
