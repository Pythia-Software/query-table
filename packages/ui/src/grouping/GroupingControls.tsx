import { useState } from "react";
import {
  GROUP_KEY_INTERVALS,
  groupKeyField,
  isCalendarGroupKey,
  MAX_GROUP_BY_FIELDS,
  MAX_METRIC_DATE_EVERY,
  METRIC_HOUR_EVERY,
  OP_LABEL,
  type CalendarGroupKey,
  type GroupKey,
  type GroupedRow,
  type SummaryOp,
} from "@pythia-software/query-table-core";
import type {
  GroupingApi,
  QueryTableApi,
} from "@pythia-software/query-table-react";
import { Icon } from "../Icon";
import { ClippedText } from "../hoverTitle";
import { PickerAnchor } from "../PickerAnchor";
import { FieldPicker } from "../FieldPicker";
import { QueryFilterRow, type SelectPresentation } from "../QueryBuilder";
import { RepresentativeControl } from "./RepresentativeEditor";
import { columnRole, ColumnRoleBadge } from "./ColumnRole";
import { availableSummaryOps, ColumnPicker } from "./ColumnPicker";
import { GroupedColumnsEditor } from "./GroupedColumnsEditor";

/** Intents validate synchronously; keep failures in the query's notice area
 * and let the initiating picker finish closing normally. */
function runGroupingIntent(controller: GroupingApi<GroupedRow>, intent: () => void) {
  try {
    intent();
  } catch (error) {
    controller.setNotice(error instanceof Error ? error.message : String(error));
  }
}

/** The timezone a new calendar key starts in: the viewer's own. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "day", or "3 days" for a key bucketing several intervals. */
function calendarKeyUnit(key: CalendarGroupKey): string {
  return (key.every ?? 1) > 1 ? `${key.every} ${key.interval}s` : key.interval;
}

/** "by day · America/Denver" for a calendar key, "" for an exact key. */
function groupKeyIntervalLabel(key: GroupKey): string {
  return isCalendarGroupKey(key)
    ? `by ${calendarKeyUnit(key)} · ${key.timeZone ?? "UTC"}`
    : "";
}

/** Pick exact values or a calendar interval, and how many intervals each
 * group spans, for a datetime group key. */
function KeyIntervalControl({
  value,
  label,
  onChange,
}: {
  value: GroupKey;
  label: string;
  onChange: (key: GroupKey) => void;
}) {
  const field = groupKeyField(value);
  const interval = isCalendarGroupKey(value) ? value.interval : "";
  return (
    <>
      <span
        className="qt-group-op-control qt-group-key-interval"
        title={isCalendarGroupKey(value) ? `One group per ${calendarKeyUnit(value)} in ${value.timeZone ?? "UTC"}` : "One group per exact value"}
      >
        <span aria-hidden="true">{isCalendarGroupKey(value) ? `by ${calendarKeyUnit(value)}` : "exact"}</span>
        <Icon name="chevronDown" size={12} />
        <select
          className="qt-group-op"
          aria-label={`Interval for ${label}`}
          value={interval}
          onChange={(event) => {
            const next = event.target.value as CalendarGroupKey["interval"] | "";
            // A new interval starts at one interval per group: 6 hours must
            // not become 6 months.
            onChange(
              next
                ? {
                    field,
                    interval: next,
                    timeZone: isCalendarGroupKey(value)
                      ? (value.timeZone ?? "UTC")
                      : localTimeZone(),
                  }
                : field,
            );
          }}
        >
          <option value="">Exact value</option>
          {GROUP_KEY_INTERVALS.map((option) => (
            <option key={option} value={option}>
              By {option}
            </option>
          ))}
        </select>
      </span>
      {isCalendarGroupKey(value) && (
        <KeyEveryInput value={value} label={label} onChange={onChange} />
      )}
    </>
  );
}

/** Intervals per group for a calendar key. Typing is kept as a draft and
 * committed, rounded and clamped to 1–1,000, on blur or Enter; Escape or an
 * empty field restores the key's count. */
function KeyEveryInput({
  value,
  label,
  onChange,
}: {
  value: CalendarGroupKey;
  label: string;
  onChange: (key: GroupKey) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ariaLabel = `${value.interval[0]!.toUpperCase()}${value.interval.slice(1)}s per group for ${label}`;
  if (value.interval === "hour")
    // Hour groups divide a day, aligned to local midnight.
    return (
      <select
        className="qt-group-key-every"
        aria-label={ariaLabel}
        title="Each group spans this many hours from each local midnight; the count divides a day"
        value={value.every ?? 1}
        onChange={(event) => {
          const every = Number(event.target.value);
          const { every: _every, ...rest } = value;
          onChange(every > 1 ? { ...rest, every } : rest);
        }}
      >
        {METRIC_HOUR_EVERY.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    );
  const commit = () => {
    const n = Number(draft);
    if (draft !== null && draft.trim() && Number.isFinite(n)) {
      const every = Math.max(1, Math.min(MAX_METRIC_DATE_EVERY, Math.round(n)));
      const { every: _every, ...rest } = value;
      if (every !== (value.every ?? 1)) onChange(every > 1 ? { ...rest, every } : rest);
    }
    setDraft(null);
  };
  return (
    <input
      className="qt-group-key-every"
      type="number"
      min={1}
      max={MAX_METRIC_DATE_EVERY}
      step={1}
      aria-label={ariaLabel}
      title={`Each group spans this many ${value.interval}s, counted from 1970`}
      value={draft ?? value.every ?? 1}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape" && draft !== null) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

function GroupingClauses({
  controller,
}: {
  controller: GroupingApi<GroupedRow>;
}) {
  const [adding, setAdding] = useState(false);
  const { view, model } = controller;
  const groupKeys: GroupKey[] = view.groupKeys ?? view.keys;
  const canAddKey = controller.supported && view.keys.length < MAX_GROUP_BY_FIELDS &&
    model.groupableFields.some(field => !view.keys.includes(field.name));
  function changeKeys(keys: GroupKey[]) {
    runGroupingIntent(controller, () => controller.changeKeys(keys));
  }
  const picker = adding && canAddKey && (
    <FieldPicker
      title="Group rows by"
      fields={model.groupableFields.filter(
        (field) => !view.keys.includes(field.name),
      )}
      onPick={(field) => {
        changeKeys([...groupKeys, field.name]);
        setAdding(false);
      }}
      onClose={() => setAdding(false)}
    />
  );
  if (view.mode === "rows")
    return canAddKey ? (
      <div className="qt-qb-row qt-group-entry qt-qb-row--unused">
        <PickerAnchor>
          <button
            type="button"
            className="qt-add"
            aria-label="Add group by"
            aria-haspopup="dialog"
            aria-expanded={adding}
            onClick={() => setAdding(true)}
          >
            <Icon name="add" />
            add group by
          </button>
          {picker}
        </PickerAnchor>
      </div>
    ) : null;
  return (
    <section
      className={`qt-group-clauses${view.result.where.length ? " qt-group-clauses--filtered" : ""}`}
      aria-label="Grouping and HAVING"
    >
      <div className="qt-qb-row">
        <div className="qt-qb-section-header">
          <span className="qt-qb-kw" data-mobile-label="Group by">
            group by
          </span>
        </div>
        {groupKeys.map((groupKey, index) => {
          const key = groupKeyField(groupKey);
          const label = model.sourceField(key)?.label ?? key;
          return (
          <span className="qt-chip" key={key}>
            <span
              className="qt-chip-field qt-column-label"
              data-column-role="key"
            >
              {label}
            </span>
            {model.sourceField(key)?.type === "datetime" && controller.supported ? (
              <KeyIntervalControl
                value={groupKey}
                label={label}
                onChange={(next) =>
                  changeKeys(
                    groupKeys.map((other, i) => (i === index ? next : other)),
                  )
                }
              />
            ) : isCalendarGroupKey(groupKey) ? (
              <span className="qt-group-key-interval">{groupKeyIntervalLabel(groupKey)}</span>
            ) : null}
            <button
              type="button"
              className="qt-chip-x"
              aria-label={`Remove ${label} grouping`}
              onClick={() =>
                changeKeys(
                  groupKeys.filter((_, i) => i !== index),
                )
              }
            >
              <Icon name="close" />
            </button>
          </span>
          );
        })}
        <PickerAnchor>
          {canAddKey && (
              <button
                type="button"
                className="qt-add"
                aria-label="Group by additional key"
                aria-haspopup="dialog"
                aria-expanded={adding}
                onClick={() => setAdding(true)}
              >
                <Icon name="add" />
                group by additional key
              </button>
            )}
          {picker}
        </PickerAnchor>
        <RepresentativeControl
          model={model}
          value={view.representative}
          onChange={rule => runGroupingIntent(controller, () => controller.changeRepresentative(rule))}
          columnCount={
            view.summaries.filter((column) => column.op === "row").length
          }
          impact={controller.representativeImpact()}
          allowRemove
        />
      </div>
      <QueryFilterRow
        api={controller.grouped}
        fields={controller.schema.fields}
        label="having"
      />
    </section>
  );
}

/** Default presentation for the headless grouping API. The ordinary row editor
 * stays intact; the aggregate workbench appears only after GROUP BY. */
export function useGroupingPresentation<Row>(
  api: QueryTableApi<Row>,
  enabled = true,
) {
  const [formulaField, setFormulaField] = useState<string | null>(null);
  const controller = enabled
    ? (api.grouping as unknown as GroupingApi<GroupedRow> | undefined)
    : undefined;
  if (!controller) return {};
  const { view, model } = controller;
  const groupKeys: GroupKey[] = view.groupKeys ?? view.keys;
  const grouped = view.mode === "groups";
  const selectPresentation: SelectPresentation | undefined = grouped
    ? {
        renderChip: (field, label) => {
          const role = columnRole(field, view, model);
          const column = view.summaries.find((c) => c.id === field);
          if (!column || column.op === "formula" || column.op === "row" || column.op === "link") {
            const shown = column?.op === "row" && column.field
              ? (model.sourceField(column.field)?.label ?? label)
              : label;
            // A ROW column shows its source field; its own label is then help.
            return (
              <span className="qt-column-label" data-column-role={role?.kind}>
                <ColumnRoleBadge role={role} />
                <ClippedText className="qt-chip-field" text={shown} title={label} />
              </span>
            );
          }
          return (
            <span className="qt-column-label" data-column-role={role?.kind}>
              <span className="qt-group-op-control">
                <span aria-hidden="true">{OP_LABEL[column.op]}</span>
                <Icon name="chevronDown" size={12} />
                <select
                  className="qt-group-op"
                  aria-label={`Aggregation for ${label}`}
                  title={role?.title}
                  value={column.op}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    runGroupingIntent(controller, () =>
                      controller.changeSummary(
                        column.id,
                        event.target.value as SummaryOp,
                      ),
                    )
                  }
                >
                  {availableSummaryOps(
                    model,
                    column.field,
                    view.summaries,
                    api.select.visible.map((c) => c.field),
                    view.representative,
                    column.id,
                  ).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op]}
                    </option>
                  ))}
                </select>
              </span>
              <span className="qt-chip-field">
                {column.field ? model.sourceField(column.field)?.label : "Rows"}
              </span>
            </span>
          );
        },
        renderPicker: (onClose) => (
          <ColumnPicker
            model={model}
            keys={view.keys}
            summaries={view.summaries}
            representative={view.representative}
            fields={controller.schema.fields}
            selected={api.select.visible.map((c) => c.field)}
            onField={api.select.show}
            onSummary={(op, field) => runGroupingIntent(controller, () => controller.addSummary(op, field))}
            onCustom={setFormulaField}
            onClose={onClose}
          />
        ),
        renderEditor: (onClose) => (
          <GroupedColumnsEditor controller={controller} onClose={onClose} />
        ),
      }
    : undefined;
  return {
    clauses: <GroupingClauses controller={controller} />,
    whereRow: grouped ? (
      <QueryFilterRow
        api={controller.source}
        fields={model.inputSchema.fields}
      />
    ) : undefined,
    selectPresentation,
    summary: grouped ? (
      <span>
        WHERE{" "}
        {view.input.where.length
          ? `${view.input.where.length} source filter(s)`
          : "all rows"}{" "}
        · GROUP BY{" "}
        <strong>
          {groupKeys
            .map((key) => {
              const name = groupKeyField(key);
              const label = model.sourceField(name)?.label ?? name;
              return isCalendarGroupKey(key) ? `${label} (${calendarKeyUnit(key)})` : label;
            })
            .join(" + ")}
        </strong>{" "}
        · HAVING{" "}
        {view.result.where.length
          ? `${view.result.where.length} group filter(s)`
          : "all groups"}
      </span>
    ) : undefined,
    overlays: (
      <>
        {formulaField !== null && grouped && (
          <GroupedColumnsEditor
            controller={controller}
            initialFormulaField={formulaField}
            onClose={() => setFormulaField(null)}
          />
        )}
        {controller.notice && (
          <div className="qt-group-notice" role="status">
            <span>{controller.notice}</span>
            <button
              type="button"
              className="qt-icon-btn"
              aria-label="Dismiss notice"
              onClick={() => controller.setNotice("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </>
    ),
  };
}
