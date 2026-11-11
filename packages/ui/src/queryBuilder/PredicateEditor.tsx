// Editing one WHERE predicate: operator labels, OpPicker, PredicateEditor and the
// type-aware ValueInput.

import type { QueryFilterApi } from "@pythia-software/query-table-react";
import {
  PresentedValueInput,
  useFilterValuePresentation,
} from "../FilterValuePresentation";
import {
  Fragment,
  useMemo,
} from "react";
import type {
  FieldDef,
  FilterOp,
  OpChoice,
  WhereClause,
} from "@pythia-software/query-table-core";
import {
  NULLARY_OPS,
  filterValues as filterValuesFor,
  opPairsForField,
  negateClause,
  opsForField,
} from "@pythia-software/query-table-core";
import type { QueryBuilderClassNames } from "../classNames";
import { useMobileLayout } from "../AdaptiveOverlay";
import { Icon } from "../Icon";
import { MenuButton, MenuGroup, MenuItem } from "../Menu";
import { FilterValueAutocomplete } from "../FilterValueAutocomplete";
import { cx, chipFieldWidthForInput } from "./helpers";

/** Human-readable operator labels for the WHERE chips + op picker. */
const OP_LABEL: Record<FilterOp, string> = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  matches_regex: "matches",
  not_matches_regex: "not matches",
  length_gt: "length above",
  length_lt: "length below",
  length_eq: "length equals",
  includes: "includes",
  is_null: "is null",
  is_not_null: "is not null",
};

export function choiceLabel(op: FilterOp, negated: boolean, value?: string): string {
  if (value === "0" && op === "length_eq")
    return negated ? "is not empty string" : "is empty string";
  if (value === "0" && op === "length_gt")
    return negated ? "is empty string" : "is not empty string";
  return negated ? `not ${OP_LABEL[op]}` : OP_LABEL[op];
}

/** The operator control: a button showing the current condition that opens a
 *  keep/exclude popover — the same two-column layout as the CellMenu, with the
 *  active choice highlighted. Picking sets the predicate's op + negation. */
function OpPicker<Row>({
  field,
  clause,
  disabled,
  classNames,
  onPick,
}: {
  field: FieldDef<Row> | undefined;
  clause: WhereClause;
  disabled: boolean | undefined;
  classNames: QueryBuilderClassNames | undefined;
  onPick: (choice: OpChoice) => void;
}) {
  const pairs = useMemo(() => (field ? opPairsForField(field) : []), [field]);
  const visiblePairs =
    clause.value === "0" && pairs.some((pair) => pair.keep.op === "length_gt")
      ? pairs.filter((pair) => pair.keep.op !== "length_eq")
      : pairs;
  const isActive = (choice: OpChoice) => {
    const resolved = choice.negated
      ? negateClause(
          { field: clause.field, op: choice.op, value: clause.value },
          field ? opsForField(field) : undefined,
        )
      : { op: choice.op, negated: false };
    return (
      resolved.op === clause.op &&
      Boolean(resolved.negated) === Boolean(clause.negated)
    );
  };

  return (
    <span className="qt-op-picker">
      <MenuButton label="Choose condition" width={320}
        buttonProps={{ className: cx("qt-chip-op-btn", "qt-op-trigger", classNames?.select), disabled: disabled || visiblePairs.length === 0,
          "aria-label": choiceLabel(clause.op, Boolean(clause.negated), clause.value) }}
        trigger={<>{choiceLabel(clause.op, Boolean(clause.negated), clause.value)}<Icon name="chevronDown" size={12} className="qt-op-caret" /></>}>
          <MenuGroup label={`Condition for ${field?.label ?? clause.field}`} columns={2} className="qt-op-pop">
            <span className="qt-cm-col-head">keep</span>
            <span className="qt-cm-col-head qt-cm-col-head--neg">exclude</span>
            {visiblePairs.map((pair, i) => (
              <Fragment key={i}>
                <MenuItem className={cx("qt-op-cell", isActive(pair.keep) && "qt-op-cell--on")}
                  checked={isActive(pair.keep)} selectionType="radio" onSelect={() => onPick(pair.keep)}>
                  {choiceLabel(pair.keep.op, pair.keep.negated, clause.value)}
                </MenuItem>
                <MenuItem className={cx("qt-op-cell", "qt-op-cell--neg", isActive(pair.exclude) && "qt-op-cell--on")}
                  checked={isActive(pair.exclude)} selectionType="radio" tone="danger" onSelect={() => onPick(pair.exclude)}>
                  {choiceLabel(pair.exclude.op, pair.exclude.negated, clause.value)}
                </MenuItem>
              </Fragment>
            ))}
          </MenuGroup>
      </MenuButton>
    </span>
  );
}

/** The editor for one predicate: field label, the operator picker (a keep/
 *  exclude popover that also carries negation), a type-aware value input, and
 *  remove. Shared by standalone and grouped terms. */
export function PredicateEditor<Row>({
  api,
  field,
  clause,
  classNames,
  disabled,
  onChange,
  onRemove,
  showField = true,
}: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row> | undefined;
  clause: WhereClause;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
  onChange: (next: WhereClause) => void;
  onRemove: () => void;
  showField?: boolean;
}) {
  const mobile = useMobileLayout();
  const needsValue = !NULLARY_OPS.has(clause.op);
  const isRegex =
    clause.op === "matches_regex" || clause.op === "not_matches_regex";
  const isLength =
    clause.op === "length_gt" ||
    clause.op === "length_lt" ||
    clause.op === "length_eq";

  function pickOp(choice: OpChoice) {
    const nextIsLength =
      choice.op === "length_gt" ||
      choice.op === "length_lt" ||
      choice.op === "length_eq";
    const value = isLength === nextIsLength ? clause.value : "";
    const next: WhereClause = { field: clause.field, op: choice.op, value };
    onChange(
      choice.negated
        ? negateClause(next, field ? opsForField(field) : undefined)
        : next,
    );
  }

  const conditionControl = (
    <OpPicker
      field={field}
      clause={clause}
      disabled={disabled}
      classNames={classNames}
      onPick={pickOp}
    />
  );
  const valueControl = needsValue ? (
    <ValueInput
      api={api}
      field={field}
      value={clause.value}
      // Filter edits reset paging; neither that nor this value changes the surrounding context.
      contextKey={JSON.stringify({ ...api.query, offset: 0 }, (_key, entry) =>
        entry === clause ? { ...clause, value: "" } : entry,
      )}
      forceFreeform={isRegex || isLength}
      numeric={isLength}
      placeholder={
        isRegex
          ? "regex"
          : isLength
            ? "length"
            : field?.type === "datetime"
              ? "ISO date or signed duration"
              : "value"
      }
      classNames={classNames}
      onChange={(value) => onChange({ ...clause, value })}
    />
  ) : null;
  const removeControl = (
    <button
      type="button"
      className={mobile ? "qt-mobile-form-remove" : "qt-chip-x"}
      onClick={onRemove}
      disabled={disabled}
      aria-label={`Remove ${field?.label ?? clause.field} filter`}
    >
      {mobile ? "Remove filter" : <Icon name="close" />}
    </button>
  );

  if (mobile)
    return (
      <div className="qt-mobile-predicate qt-mobile-form">
        {showField && (
          <strong className="qt-mobile-form-field--wide">
            {field?.label ?? clause.field}
          </strong>
        )}
        <label
          className={cx(
            "qt-mobile-form-field",
            !needsValue && "qt-mobile-form-field--wide",
          )}
        >
          <span>Condition</span>
          {conditionControl}
        </label>
        {valueControl && (
          <label className="qt-mobile-form-field">
            <span>Value</span>
            {valueControl}
          </label>
        )}
        {removeControl}
      </div>
    );

  return (
    <span className="qt-pred">
      <span className="qt-chip-field">{field?.label ?? clause.field}</span>
      {conditionControl}
      {valueControl}
      {removeControl}
    </span>
  );
}

// ---- value input: autocomplete by default --------------------------------

function ValueInput<Row>({
  api,
  field,
  value,
  contextKey,
  forceFreeform,
  numeric,
  placeholder = "value",
  classNames,
  onChange,
}: {
  api: QueryFilterApi<Row>;
  field: FieldDef<Row> | undefined;
  value: string;
  contextKey: string;
  forceFreeform?: boolean;
  numeric?: boolean;
  placeholder?: string;
  classNames: QueryBuilderClassNames | undefined;
  onChange: (v: string) => void;
}) {
  const presentation = useFilterValuePresentation();
  const strategy = field
    ? filterValuesFor(field)
    : { source: "freeform" as const };

  // Static closed domain → a plain <select> of the options.
  if (!forceFreeform && strategy.source === "static") {
    if (
      presentation.render ||
      presentation.label ||
      strategy.options.some((o) => typeof o !== "string")
    ) {
      return (
        <PresentedValueInput
          field={field?.name ?? ""}
          value={value}
          options={strategy.options}
          onChange={onChange}
        />
      );
    }
    return (
      <select
        className={cx("qt-chip-val", classNames?.select)}
        aria-label={`Value for ${field?.label ?? "filter"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {strategy.options.map((o) => {
          const option = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          );
        })}
      </select>
    );
  }

  // Freeform → a plain input, no suggestions.
  if (forceFreeform || strategy.source === "freeform" || !field) {
    const widthChars = chipFieldWidthForInput(
      value || placeholder,
      field?.type,
      5,
      4,
    );
    return (
      <input
        className={cx("qt-chip-val", classNames?.input)}
        value={value}
        placeholder={placeholder}
        aria-label={`${placeholder} for ${field?.label ?? "filter"}`}
        inputMode={numeric ? "numeric" : undefined}
        pattern={numeric ? "[0-9]*" : undefined}
        size={widthChars}
        style={{ width: `${widthChars}ch` }}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // Autocomplete (the default) → debounced combobox backed by api.filterValues.
  return (
    <FilterValueAutocomplete
      api={api}
      field={field}
      value={value}
      contextKey={contextKey}
      className={cx("qt-chip-val", classNames?.input)}
      widthChars={chipFieldWidthForInput(value || "value", field.type, 5, 4)}
      onChange={onChange}
    />
  );
}
