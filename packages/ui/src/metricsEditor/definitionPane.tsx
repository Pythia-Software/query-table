// Definition pane body for the selected metric: name, expression editor,
// validation and the settings groups (grouping, ordering and display live in
// their own files). Plain render function, not a component.
import { lazy, Suspense } from "react";
import {
  aggOpsForField,
  compileFormula,
  compileMetric,
  metricExpression,
  type AggregationClause,
} from "@pythia-software/query-table-core";
import { MetricWhereEditor } from "../MetricWhereEditor";
import {
  defaultLayout,
  titleOf,
  withoutIntervalDisplay,
  simpleAggregate,
} from "./shared";
import { Settings } from "./controls";
import { MetricSeriesSettings } from "./MetricSeriesSettings";
import { MetricIntervalSettings } from "./MetricIntervalSettings";
import { type MetricsEditorState } from "./useMetricsEditorState";
import { renderGroupingSettings } from "./groupingSettings";
import { renderOrderingSettings } from "./orderingSettings";
import { renderDisplaySettings } from "./displaySettings";

const FormulaEditor = lazy(() => import("../FormulaEditor"));

/** The definition pane's content for the selected metric. */
export function renderMetricDefinition<Row>(
  state: MetricsEditorState<Row>,
  selected: AggregationClause,
) {
  const {
    api, fields, locale, inputY, settingsState, setInputTarget, input, chosen,
    rowInput, measurable, computationDiagnostics, diagnostics, intervalReasons,
    patchWhere, patch, displayPatch, shareDisplay, changeExpression,
    finishInsertion, sizeControls,
  } = state;
  return (
    <>
      <label>
        Metric name
        <input
          aria-label="Metric name"
          maxLength={1000}
          value={selected.label ?? titleOf(selected, fields)}
          onChange={(e) =>
            patch(selected.id, { label: e.target.value })
          }
        />
      </label>
      <div className="qt-metric-expression-heading">
        <strong>
          {["box", "histogram", "quantiles"].includes(chosen.kind)
            ? "Values to summarize"
            : chosen.kind === "scatter"
              ? "X expression"
              : "Expression"}
        </strong>
        {!["box", "histogram", "quantiles", "scatter"].includes(chosen.kind) && (
          <div
            className="qt-metric-mode"
            role="group"
            aria-label="Expression mode"
          >
            <button
              type="button"
              aria-pressed={selected.expression === undefined}
              disabled={
                selected.expression !== undefined &&
                !simpleAggregate(selected, fields)
              }
              title={
                selected.expression !== undefined &&
                !simpleAggregate(selected, fields)
                  ? "This formula cannot be represented in Basic"
                  : undefined
              }
              onClick={() => {
                const basic = simpleAggregate(selected, fields);
                if (basic)
                  patch(selected.id, {
                    op: basic.op,
                    field: basic.field,
                    expression: undefined,
                  });
              }}
            >
              Basic
            </button>
            <button
              type="button"
              aria-pressed={selected.expression !== undefined}
              onClick={() =>
                patch(selected.id, {
                  expression: metricExpression(selected),
                })
              }
            >
              Formula
            </button>
          </div>
        )}
      </div>
      {selected.expression === undefined &&
      !["box", "histogram", "quantiles", "scatter"].includes(chosen.kind) ? (
        <div className="qt-metric-basic">
          <select
            aria-label="Aggregation function"
            value={selected.op}
            onChange={(e) =>
              patch(selected.id, {
                op: e.target.value as AggregationClause["op"],
              })
            }
          >
            {(selected.field &&
            fields.find((f) => f.name === selected.field)
              ? aggOpsForField(
                  fields.find((f) => f.name === selected.field)!,
                )
              : ["count"]
            ).map((op) => (
              <option key={op} value={op}>
                {op.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            aria-label="Measure field"
            value={selected.field ?? ""}
            onChange={(e) => {
              const field = e.target.value;
              const definition = fields.find((f) => f.name === field);
              patch(selected.id, {
                field: field || undefined,
                op:
                  definition &&
                  aggOpsForField(definition).includes(selected.op)
                    ? selected.op
                    : "count",
              });
            }}
          >
            <option value="">All rows</option>
            {measurable.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <Suspense fallback={<p>Loading expression editor…</p>}>
          <FormulaEditor
            key={`${selected.id}-x`}
            value={
              rowInput
                ? (selected.distribution?.input ?? "NULL")
                : metricExpression(selected)
            }
            onChange={(source) => changeExpression(source)}
            fields={fields}
            compile={(source) =>
              api.aggregations.compile
                ? api.aggregations.compile(
                    rowInput
                      ? {
                          ...selected,
                          distribution: {
                            ...selected.distribution!,
                            input: source,
                          },
                        }
                      : { ...selected, expression: source },
                  )
                : rowInput
                  ? compileFormula(source, fields)
                  : compileMetric(source, fields)
            }
            rows={3}
            suggestions={false}
            showLibrary={false}
            ariaLabel="Metric expression"
            inputRef={input}
            onReady={finishInsertion}
            onFocus={() => setInputTarget("primary")}
          />
        </Suspense>
      )}
      {chosen.kind === "scatter" && (
        <>
          <strong>Y expression</strong>
          <Suspense fallback={<p>Loading expression editor…</p>}>
            <FormulaEditor
              key={`${selected.id}-y`}
              value={selected.expressionY ?? "COUNT()"}
              onChange={(source) => changeExpression(source, true)}
              fields={fields}
              compile={(source) =>
                api.aggregations.compile
                  ? api.aggregations.compile({
                      ...selected,
                      expressionY: source,
                    })
                  : compileMetric(source, fields)
              }
              rows={3}
              suggestions={false}
              showLibrary={false}
              ariaLabel="Y metric expression"
              inputRef={inputY}
              onFocus={() => setInputTarget("secondary")}
            />
          </Suspense>
        </>
      )}
      {diagnostics.get(selected.id) &&
        (!computationDiagnostics.has(selected.id) ||
          (selected.expression === undefined &&
            !["box", "histogram", "quantiles", "scatter"].includes(
              chosen.kind,
            ))) && (
          <p className="qt-metric-editor-error" role="status">
            {diagnostics.get(selected.id)}
          </p>
        )}
      {!diagnostics.has(selected.id) && (
        <p className="qt-metric-validation">✓ Valid expression</p>
      )}
      <Settings
        title="Data scope"
        {...settingsState("Data scope")}
        summary={`${
          selected.scope === "shownRows"
            ? "Shown rows"
            : "All matching rows"
        }${
          selected.where?.length
            ? ` · only rows where ${selected.where.length} ${selected.where.length === 1 ? "filter matches" : "filters match"}`
            : ""
        }`}
      >
        <div
          className="qt-metric-scope"
          role="group"
          aria-label="Calculate over"
        >
          {(["allMatching", "shownRows"] as const).map((scope) => (
            <button
              type="button"
              key={scope}
              aria-pressed={
                (selected.scope ?? "allMatching") === scope
              }
              onClick={() => patch(selected.id, { scope })}
            >
              {scope === "allMatching"
                ? "All matching rows"
                : "Shown rows"}
            </button>
          ))}
        </div>
        <p className="qt-metric-help">
          {selected.scope === "shownRows"
            ? "Uses only rows on the current page, after sorting and paging."
            : "Uses every matching row; ignores the table’s limit and offset."}
        </p>
        <div
          className="qt-metric-where"
          role="group"
          aria-label="Only rows where"
        >
          <strong>Only rows where…</strong>
          <MetricWhereEditor
            api={api}
            fields={fields}
            where={selected.where ?? []}
            onChange={(update) => patchWhere(selected.id, update)}
          />
          <p className="qt-metric-help">
            Narrows this metric only. The table’s rows and other
            metrics are unchanged.
          </p>
        </div>
      </Settings>
      {renderGroupingSettings(state, selected)}
      {selected.groupBy.length > 0 &&
        !["box", "histogram", "quantiles", "scatter"].includes(chosen.kind) && (
          <MetricSeriesSettings
            clause={selected}
            fields={fields}
            settings={settingsState("Window & share")}
            onChange={(values) =>
              patch(selected.id, {
                ...values,
                ...("share" in values
                  ? shareDisplay(selected.share, values.share)
                  : {}),
              })
            }
          />
        )}
      {/* Shown when an interval is set, or some kind could apply. */}
      {(selected.interval ||
        (!["box", "histogram", "scatter"].includes(chosen.kind) &&
          (!intervalReasons || !intervalReasons.proportion || !intervalReasons.rate))) && (
        <MetricIntervalSettings
          interval={selected.interval}
          reasons={intervalReasons ?? {}}
          display={chosen}
          locale={locale}
          settings={settingsState("Confidence interval")}
          onChange={(interval) =>
            patch(selected.id, {
              interval,
              // Turning the interval off drops its display setting.
              ...(interval ? {} : { display: withoutIntervalDisplay(chosen) }),
            })
          }
          onDisplayChange={(show) =>
            patch(selected.id, {
              display: show
                ? withoutIntervalDisplay(chosen)
                : { ...chosen, showIntervals: false },
            })
          }
        />
      )}
      {renderOrderingSettings(state, selected)}
      {renderDisplaySettings(state, selected)}
      <Settings
        title="Labels"
        {...settingsState("Labels")}
        summary={
          [chosen.valueLabel, chosen.xLabel, chosen.yLabel].some(
            Boolean,
          )
            ? "Custom"
            : "Automatic"
        }
      >
        {(["valueLabel", "xLabel", "yLabel"] as const).map((key) => (
          <label key={key}>
            {
              {
                valueLabel: "Value label",
                xLabel: "X axis label",
                yLabel: "Y axis label",
              }[key]
            }
            <input
              maxLength={1000}
              value={chosen[key] ?? ""}
              onChange={(e) =>
                displayPatch({ [key]: e.target.value })
              }
            />
          </label>
        ))}
      </Settings>
      <Settings
        title="Card size"
        {...settingsState("Card size")}
        summary={`${(selected.layout ?? defaultLayout).widthRem} × ${(selected.layout ?? defaultLayout).heightRem} rem · min ${(selected.layout ?? defaultLayout).minWidthRem} × ${(selected.layout ?? defaultLayout).minHeightRem}`}
      >
        {sizeControls}
      </Settings>
    </>
  );
}
