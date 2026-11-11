// "Display" settings of the definition pane: chart kind, formats and
// per-kind options. Plain render function, not a component.
import {
  MAX_QUANTILE_PROBABILITIES,
  type AggregationClause,
  type MetricDisplay,
} from "@pythia-software/query-table-core";
import { metricKeyColored } from "../metricColors";
import { kinds, defaultProbabilities } from "./shared";
import { MetricNumberInput, Settings } from "./controls";
import { MetricFormatControls } from "./MetricFormatControls";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The "Display" settings of the selected metric. */
export function renderDisplaySettings<Row>(
  state: MetricsEditorState<Row>,
  selected: AggregationClause,
) {
  const {
    locale, settingsState, formatTarget, setFormatTarget, chosen, fieldLabel,
    patch, displayPatch, changeDisplay, selectedResult, valueFormat, setFormat,
  } = state;
  return (
    <Settings
      title="Display"
      {...settingsState("Display")}
      summary={`${kinds.find(([kind]) => kind === chosen.kind)?.[1] ?? chosen.kind}${chosen.format ? ` · ${chosen.format.kind}` : ""}`}
    >
      {chosen.kind === "scatter" && (
        <label>
          Format measure
          <select
            aria-label="Format measure"
            value={formatTarget}
            onChange={(e) =>
              setFormatTarget(e.target.value as "x" | "y")
            }
          >
            <option value="x">X output</option>
            <option value="y">Y output</option>
          </select>
        </label>
      )}
      <MetricFormatControls
        displayControl={
          <label>
            Display
            <select
              aria-label="Metric display"
              value={chosen.kind}
              onChange={(e) =>
                changeDisplay(
                  e.target.value as MetricDisplay["kind"],
                )
              }
            >
              {kinds.map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        }
        format={valueFormat}
        onChange={setFormat}
        sample={
          chosen.kind === "histogram" &&
          selectedResult?.buckets[0]?.distribution?.kind ===
            "histogram"
            ? selectedResult.buckets[0].distribution.edges[0]
            : formatTarget === "y"
              ? selectedResult?.buckets[0]?.y
              : selectedResult?.buckets[0]?.value
        }
        locale={locale}
      />
      {[
        "bar-horizontal",
        "bar-vertical",
        "line",
        "scatter",
        "box",
        "histogram",
        "quantiles",
        "list",
      ].includes(chosen.kind) && (
        <details className="qt-metric-settings">
          <summary>Scale & bounds</summary>
          {(chosen.kind === "scatter" ||
          chosen.kind === "histogram" ||
          chosen.kind === "line"
            ? (["xScale", "yScale"] as const)
            : ([
                chosen.kind === "box" ||
                chosen.kind === "quantiles" ||
                chosen.kind === "bar-horizontal" ||
                chosen.kind === "list"
                  ? "xScale"
                  : "yScale",
              ] as const)
          ).map((key) => (
            <fieldset key={key} className="qt-metric-axis-settings">
              <legend>
                {key === "xScale"
                  ? "X / horizontal axis"
                  : "Y / vertical axis"}
              </legend>
              <label>
                Scale
                <select
                  aria-label={`${key === "xScale" ? "X" : "Y"} axis scale`}
                  value={chosen[key]?.mode ?? "linear"}
                  onChange={(e) =>
                    displayPatch({
                      [key]: {
                        ...chosen[key],
                        mode: e.target.value,
                      },
                    })
                  }
                >
                  <option value="linear">Linear</option>
                  <option value="log">Logarithmic</option>
                </select>
              </label>
              {(["min", "max"] as const).map((bound) => (
                <label key={bound}>
                  {bound === "min" ? "Minimum" : "Maximum"}
                  <input
                    type="number"
                    step="any"
                    placeholder="Automatic"
                    aria-label={`${key === "xScale" ? "X" : "Y"} axis ${bound}`}
                    value={chosen[key]?.[bound] ?? ""}
                    onChange={(e) => {
                      if (e.target.validity.badInput) return;
                      const next = { ...chosen[key] };
                      if (e.target.value === "") delete next[bound];
                      else next[bound] = Number(e.target.value);
                      displayPatch({ [key]: next });
                    }}
                  />
                </label>
              ))}
            </fieldset>
          ))}
          <p className="qt-muted">
            Bounds use raw result units. Logarithmic axes omit zero
            and negative values. Pie and ring charts use
            proportional areas.
          </p>
        </details>
      )}
      {["pie", "donut", "scatter", "histogram", "quantiles"].includes(
        chosen.kind,
      ) && (
        <label>
          Legend placement
          <select
            aria-label="Legend placement"
            value={chosen.legendPosition ?? "right"}
            onChange={(e) =>
              displayPatch({
                legendPosition: e.target.value as NonNullable<
                  MetricDisplay["legendPosition"]
                >,
              })
            }
          >
            {(
              ["left", "right", "bottom", "top", "none"] as const
            ).map((position) => (
              <option key={position} value={position}>
                {
                  {
                    left: "Left",
                    right: "Right",
                    bottom: "Below",
                    top: "Above",
                    none: "None",
                  }[position]
                }
              </option>
            ))}
          </select>
        </label>
      )}
      {selected.groupBy.length > 1 && metricKeyColored(chosen.kind) && (
        <label>
          Colour by
          <select
            aria-label="Colour groups by"
            value={
              chosen.colorBy !== undefined &&
              selected.groupBy.includes(chosen.colorBy)
                ? chosen.colorBy
                : ""
            }
            onChange={(e) => {
              const display = { ...chosen };
              if (e.target.value) display.colorBy = e.target.value;
              else delete display.colorBy;
              patch(selected.id, { display });
            }}
          >
            <option value="">Whole group (theme default)</option>
            {selected.groupBy.map((group) => (
              <option key={group} value={group}>
                {fieldLabel(group)}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen.kind !== "value" && (
        <label>
          Maximum displayed groups
          <MetricNumberInput key={selected.id} aria-label="Maximum displayed groups" allowEmpty min={1} max={1000000} step={1} placeholder="Automatic" value={chosen.maxGroups}
            onCommit={maxGroups => {
              const display = { ...chosen };
              if (maxGroups === undefined) delete display.maxGroups;
              else display.maxGroups = maxGroups;
              patch(selected.id, { display });
            }} />
        </label>
      )}
      {["list", "pie", "donut"].includes(chosen.kind) && (
        <label>
          <input type="checkbox" aria-label="Show Other remainder" checked={chosen.showOther ?? ["pie", "donut"].includes(chosen.kind)}
            onChange={event => displayPatch({ showOther: event.target.checked })} />
          Show Other remainder (additive values only)
        </label>
      )}
      {chosen.kind === "list" && (
        <div className="qt-metric-list-controls">
          <label>
            Bar placement
            <select aria-label="List bar placement" value={chosen.list?.barPosition ?? "inline"}
              onChange={event => displayPatch({ list: { ...chosen.list, barPosition: event.target.value as "inline" | "below" } })}>
              <option value="inline">Beside label</option>
              <option value="below">Under label</option>
            </select>
          </label>
          {chosen.list?.barPosition === "below" && (
            <label>
              Maximum label lines
              <MetricNumberInput
                key={selected.id}
                aria-label="Maximum label lines"
                allowEmpty
                min={1}
                max={1000000}
                step={1}
                placeholder="Unlimited"
                value={chosen.list?.maxLabelLines}
                onCommit={(maxLabelLines) => {
                  const list = { ...chosen.list };
                  if (maxLabelLines === undefined) delete list.maxLabelLines;
                  else list.maxLabelLines = maxLabelLines;
                  displayPatch({ list });
                }}
              />
            </label>
          )}
          {(
            ["showBars", "useGroupColors", "showValues"] as const
          ).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={chosen.list?.[key] !== false}
                onChange={(e) =>
                  displayPatch({
                    list: {
                      ...chosen.list,
                      [key]: e.target.checked,
                    },
                  })
                }
              />
              {
                {
                  showBars: "Show line bars",
                  useGroupColors: "Use group colors",
                  showValues: "Show final values",
                }[key]
              }
            </label>
          ))}
        </div>
      )}
      {chosen.kind === "table" && selected.groupBy.length === 2 && (
        <>
          <label>
            <input
              type="checkbox"
              checked={chosen.pivot?.swap ?? false}
              onChange={(e) =>
                displayPatch({
                  pivot: {
                    ...chosen.pivot,
                    swap: e.target.checked,
                  },
                })
              }
            />
            Swap X/Y axes
          </label>
          {(["rowDir", "columnDir"] as const).map((key) => (
            <label key={key}>
              {key === "rowDir" ? "Row keys" : "Column keys"}
              <select
                value={chosen.pivot?.[key] ?? "asc"}
                onChange={(e) =>
                  displayPatch({
                    pivot: {
                      ...chosen.pivot,
                      [key]: e.target.value as "asc" | "desc",
                    },
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
          ))}
        </>
      )}
      {chosen.kind === "box" && selected.distribution && (
        <>
          <label>
            Whiskers
            <select
              aria-label="Box whiskers"
              value={selected.distribution.whiskers ?? "minmax"}
              onChange={(e) =>
                patch(selected.id, {
                  distribution: {
                    ...selected.distribution!,
                    whiskers: e.target.value as
                      | "minmax"
                      | "tukey"
                      | "percentile",
                  },
                })
              }
            >
              <option value="minmax">Minimum / maximum</option>
              <option value="tukey">
                1.5 × IQR · show outliers
              </option>
              <option value="percentile">Percentiles</option>
            </select>
          </label>
          {selected.distribution.whiskers === "percentile" &&
            ([0, 1] as const).map((side) => {
              const range = selected.distribution!
                .whiskerProbabilities ?? [0.1, 0.9];
              return (
                <label key={side}>
                  {side === 0
                    ? "Lower whisker percentile"
                    : "Upper whisker percentile"}
                  <MetricNumberInput
                    key={`${selected.id}-${side}`}
                    aria-label={
                      side === 0
                        ? "Lower whisker percentile"
                        : "Upper whisker percentile"
                    }
                    min={side === 0 ? 0 : 76}
                    max={side === 0 ? 24 : 100}
                    step={1}
                    value={Math.round(range[side]! * 1000) / 10}
                    onCommit={(n) => {
                      const next: [number, number] = [range[0]!, range[1]!];
                      next[side] = n / 100;
                      if (
                        next[0] >= 0 &&
                        next[0] < 0.25 &&
                        next[1] > 0.75 &&
                        next[1] <= 1
                      )
                        patch(selected.id, {
                          distribution: {
                            ...selected.distribution!,
                            whiskerProbabilities: next,
                          },
                        });
                    }}
                  />
                </label>
              );
            })}
          <label>
            <input
              type="checkbox"
              checked={chosen.boxMean !== false}
              onChange={(e) =>
                displayPatch({ boxMean: e.target.checked })
              }
            />
            Show mean marker
          </label>
        </>
      )}
      {chosen.kind === "quantiles" && selected.distribution && (() => {
        const shown = (
          selected.distribution.probabilities ?? defaultProbabilities
        )
          .map((p) => Math.round(p * 1e6) / 1e4)
          .join(", ");
        return (
          <label>
            Probabilities (percent, increasing)
            <input
              // Re-mount when the list changes elsewhere (undo,
              // links, kind switches), so the text never goes stale.
              key={`${selected.id}:${shown}`}
              aria-label="Quantile probabilities"
              defaultValue={shown}
              onBlur={(e) => {
                const probabilities = e.target.value
                  .split(/[\s,]+/)
                  .filter(Boolean)
                  .map((text) => Number(text) / 100);
                if (
                  probabilities.length >= 1 &&
                  probabilities.length <= MAX_QUANTILE_PROBABILITIES &&
                  probabilities.every(
                    (p, i) =>
                      p >= 0 &&
                      p <= 1 &&
                      (i === 0 || p > probabilities[i - 1]!),
                  )
                )
                  patch(selected.id, {
                    distribution: {
                      ...selected.distribution!,
                      probabilities,
                    },
                  });
                // An invalid list reverts to the one that runs.
                else e.target.value = shown;
              }}
            />
          </label>
        );
      })()}
      {chosen.kind === "histogram" && selected.distribution && (
        <label>
          Equal-width bins
          <MetricNumberInput
            key={selected.id}
            aria-label="Histogram bins"
            min={2}
            max={30}
            step={1}
            value={selected.distribution.bins ?? 10}
            onCommit={(n) => {
              if (Number.isInteger(n) && n >= 2 && n <= 30)
                patch(selected.id, {
                  distribution: {
                    ...selected.distribution!,
                    bins: n,
                  },
                });
            }}
          />
        </label>
      )}
    </Settings>
  );
}
