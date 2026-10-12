import { PresentedFilterValue } from "./FilterValuePresentation";
// CellMenu — right-click (or left-click) a cell → quick-filter popover + copy.
// Filters are laid out in two columns: each row is a candidate predicate on the
// left and its logical negation directly opposite (`= 5 | ≠ 5`, `≥ 5 | < 5`,
// `is null | is not null`, `contains | not contains`). Value ops are prefilled
// with the clicked cell's value; array cells get a per-element `includes` row.
// Anchors just off the click point and clamps to the viewport.

import type { ReactNode } from "react";
import { Icon } from "./Icon";
import type { FieldDef, FilterOp, WhereClause } from "@pythia-software/query-table-core";
import { NULLARY_OPS, negateClause, opsForField, opPairsForField, isFilterable } from "@pythia-software/query-table-core";
import type { MenuClassNames } from "./classNames";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "./Menu";

export interface CellMenuProps<Row> {
  field: FieldDef<Row>;
  value: unknown;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
  onAddFilter: (clause: WhereClause) => void;
  onClose: () => void;
  classNames?: MenuClassNames;
  returnFocus?: HTMLElement | null | undefined;
}

const cx = (...parts: Array<string | undefined | false>): string => parts.filter(Boolean).join(" ");

interface FilterRow {
  positive?: WhereClause;
  negative?: WhereClause;
}

export function CellMenu<Row>({ field, value, x, y, onAddFilter, onClose, classNames, returnFocus }: CellMenuProps<Row>): ReactNode {
  // A non-filterable field (e.g. a computed column that opted out) offers no
  // filter rows; only the header + copy remain. `pairs` is the shared keep/
  // exclude op source the WHERE op picker uses too, so the two read identically.
  const ops = isFilterable(field) ? opsForField(field) : [];
  const pairs = isFilterable(field) ? opPairsForField(field) : [];
  const hasNullity = pairs.some((p) => p.keep.op === "is_null");
  const isArray = Array.isArray(value);
  const isNullish = value == null || (isArray && (value as unknown[]).length === 0);
  const cellText = valueToString(value);

  function applyClause(clause: WhereClause) {
    onAddFilter(clause);
  }

  // Build one row = a positive predicate and its negation opposite.
  const rows: FilterRow[] = [];
  const pairRow = (op: FilterOp, raw: string) => {
    const positive: WhereClause = { field: field.name, op, value: NULLARY_OPS.has(op) ? "" : raw };
    rows.push({ positive, negative: negateClause(positive, ops) });
  };

  if (isArray && !isNullish) {
    // A tag column: filter by the clicked tag (and its negation), then nullity.
    const arrayOp: FilterOp = pairs.find((p) => p.keep.op === "includes")?.keep.op ?? pairs[0]?.keep.op ?? "=";
    (value as unknown[]).forEach((el) => pairRow(arrayOp, String(el)));
    if (hasNullity) pairRow("is_null", cellText);
  } else if (value === "" && field.type === "text") {
    if (ops.includes("length_eq")) {
      rows.push({
        positive: { field: field.name, op: "length_eq", value: "0" },
        negative: ops.includes("length_gt")
          ? { field: field.name, op: "length_gt", value: "0" }
          : { field: field.name, op: "length_eq", value: "0", negated: true },
      });
    }
    if (hasNullity) pairRow("is_null", cellText);
  } else if (value === "") {
    if (hasNullity) pairRow("is_null", cellText);
  } else if (!isNullish) {
    // Every keep op (value ops + nullity) prefilled with the cell value.
    for (const pair of pairs) {
      const op = pair.keep.op;
      pairRow(op, op === "length_gt" || op === "length_lt" || op === "length_eq" ? String(Array.from(cellText).length) : cellText);
    }
  } else if (hasNullity) {
    // Empty cell → only the nullity row makes sense.
    pairRow("is_null", cellText);
  }

  return (
    <Menu label={field.label} anchor={{ x: x + 4, y: y + 4 }} width={320} onClose={onClose} classNames={classNames} returnFocus={returnFocus}>
      <div className="qt-cm-header">
        <span className="qt-cm-field">{field.label}</span>
        <span className="qt-cm-value">{Array.isArray(value) ? value.map(v => <PresentedFilterValue key={String(v)} field={field.name} value={String(v)}/>) : <PresentedFilterValue field={field.name} value={String(value ?? "")}/>}</span>
      </div>
      <MenuItem
        icon={<Icon name="copy" />}
        onSelect={() => {
          // Start during the user gesture, then dismiss without waiting for permission.
          void navigator.clipboard?.writeText(cellText).catch(() => { /* denial is non-fatal */ });
        }}
      >
        copy value
      </MenuItem>
      <MenuSeparator />
      {rows.length > 0 && (
        <MenuGroup className="qt-cm-filter-grid" label="Filter by this cell" columns={2}>
          <span className="qt-cm-col-head">keep</span>
          <span className="qt-cm-col-head qt-cm-col-head--neg">exclude</span>
          {rows.map((row, i) => (
            <FilterPairRow key={i} row={row} onApply={applyClause} />
          ))}
        </MenuGroup>
      )}
    </Menu>
  );
}

function FilterPairRow({
  row,
  onApply,
}: {
  row: FilterRow;
  onApply: (clause: WhereClause) => void;
}): ReactNode {
  return (
    <>
      <FilterButton clause={row.positive} onApply={onApply} />
      <FilterButton clause={row.negative} negative onApply={onApply} />
    </>
  );
}

function FilterButton({
  clause,
  negative,
  onApply,
}: {
  clause: WhereClause | undefined;
  negative?: boolean;
  onApply: (clause: WhereClause) => void;
}): ReactNode {
  if (!clause) return <span className="qt-cm-filter-empty" aria-hidden />;
  const emptyStringLength = clause.value === "0" &&
    (clause.op === "length_eq" || clause.op === "length_gt");
  const nullary = NULLARY_OPS.has(clause.op) || emptyStringLength;
  return (
    <MenuItem
      className={cx("qt-cm-filter", negative && "qt-cm-filter--neg")}
      onSelect={() => onApply(clause)}
    >
      <span className="qt-cm-op">{predicateSymbol(clause)}</span>
      {!nullary ? (
        <>
          {" "}
          <code><PresentedFilterValue field={clause.field} value={clause.value}/></code>
        </>
      ) : null}
    </MenuItem>
  );
}

/** Human-readable label for a predicate, honoring the `negated` flag. */
function predicateSymbol(clause: WhereClause): string {
  if (clause.value === "0" && clause.op === "length_eq") {
    return clause.negated ? "exclude empty strings" : "include empty strings";
  }
  if (clause.value === "0" && clause.op === "length_gt" && !clause.negated) {
    return "exclude empty strings";
  }
  switch (clause.op) {
    case "length_gt":
      return clause.negated ? "length ≤" : "length >";
    case "length_lt":
      return clause.negated ? "length ≥" : "length <";
    case "length_eq":
      return clause.negated ? "length ≠" : "length =";
  }
  const base = opSymbol(clause.op);
  return clause.negated ? `not ${base}` : base;
}

function opSymbol(op: FilterOp): string {
  switch (op) {
    case "!=":
      return "≠";
    case ">=":
      return "≥";
    case "<=":
      return "≤";
    case "starts_with":
      return "starts with";
    case "ends_with":
      return "ends with";
    case "matches_regex":
      return "matches";
    case "not_matches_regex":
      return "not matches";
    case "is_null":
      return "is null";
    case "is_not_null":
      return "is not null";
    default:
      return op;
  }
}

function valueToString(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
