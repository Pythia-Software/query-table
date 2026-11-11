// "Ordering & limits" settings of the definition pane: sorts, group limit
// and minimum counts. Plain render function, not a component.
import {
  metricMinCount,
  metricMinCountMeasure,
  metricMinCountText,
  type AggregationClause,
} from "@pythia-software/query-table-core";
import {
  minimumKey,
  minimumOf,
  minimumAllowed,
  withMinimum,
  minimumChoices,
} from "./shared";
import { Settings } from "./controls";
import { type MetricsEditorState } from "./useMetricsEditorState";

/** The "Ordering & limits" settings of the selected metric. */
export function renderOrderingSettings<Row>(
  state: MetricsEditorState<Row>,
  selected: AggregationClause,
) {
  const {
    fields, settingsState, chosen, measurable, fieldLabel, patch,
  } = state;
  return (
    <Settings
      title="Ordering & limits"
      {...settingsState("Ordering & limits")}
      summary={`${
        selected.sort?.length
          ? `${selected.sort.length} sort ${selected.sort.length === 1 ? "rule" : "rules"}`
          : "Default ordering"
      }${selected.groupLimit ? ` · first ${selected.groupLimit}` : ""}${
        selected.minCount !== undefined
          ? ` · at least ${metricMinCountText(selected, fieldLabel)}`
          : ""
      }`}
    >
      {(selected.sort ?? []).map((sort, index) => (
        <div className="qt-metric-sort-row" key={index}>
          <select
            aria-label={`Sort result ${index + 1}`}
            value={sort.key}
            onChange={(e) =>
              patch(selected.id, {
                sort: selected.sort!.map((s, i) =>
                  i === index
                    ? { ...s, key: e.target.value as typeof s.key }
                    : s,
                ),
              })
            }
          >
            <option value="value">
              {chosen.kind === "box"
                ? "Median"
                : chosen.kind === "scatter"
                  ? "X value"
                  : "Value"}
            </option>
            {chosen.kind === "scatter" && (
              <option value="y">Y value</option>
            )}
            <option value="count">Rows</option>
            {["box", "histogram", "quantiles"].includes(chosen.kind) && (
              <option value="samples">Numeric samples</option>
            )}
            {selected.groupBy.map((g, i) => (
              <option key={g} value={`group${i}`}>
                {fields.find((f) => f.name === g)?.label ?? g}
              </option>
            ))}
          </select>
          <select
            aria-label={`Sort direction ${index + 1}`}
            value={sort.dir}
            onChange={(e) =>
              patch(selected.id, {
                sort: selected.sort!.map((s, i) =>
                  i === index
                    ? {
                        ...s,
                        dir: e.target.value as "asc" | "desc",
                      }
                    : s,
                ),
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <select
            aria-label={`Null placement ${index + 1}`}
            value={sort.nulls ?? "last"}
            onChange={(e) =>
              patch(selected.id, {
                sort: selected.sort!.map((s, i) =>
                  i === index
                    ? {
                        ...s,
                        nulls: e.target.value as "first" | "last",
                      }
                    : s,
                ),
              })
            }
          >
            <option value="last">NULL last</option>
            <option value="first">NULL first</option>
          </select>
          <button
            type="button"
            aria-label={`Remove sort ${index + 1}`}
            onClick={() =>
              patch(selected.id, {
                sort: selected.sort!.filter((_, i) => i !== index),
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="qt-btn"
        disabled={(selected.sort?.length ?? 0) >= 20}
        onClick={() =>
          patch(selected.id, {
            sort: [
              ...(selected.sort ?? []),
              { key: "value", dir: "desc", nulls: "last" },
            ],
          })
        }
      >
        + Add sort
      </button>
      <label>
        Show first groups
        <input
          aria-label="Metric group limit"
          type="number"
          min={1}
          max={10000}
          placeholder="All groups"
          value={selected.groupLimit ?? ""}
          onChange={(e) => {
            const n = e.currentTarget.valueAsNumber;
            if (!e.currentTarget.value)
              patch(selected.id, { groupLimit: undefined });
            else if (Number.isInteger(n) && n >= 1 && n <= 10000)
              patch(selected.id, { groupLimit: n });
          }}
        />
      </label>
      {(selected.groupBy.length > 0 ||
        selected.minCount !== undefined) && (
        <>
          <label>
            Minimum per group
            <input
              aria-label="Minimum per group"
              type="number"
              min={1}
              max={1000000}
              placeholder="Any size"
              value={metricMinCount(selected) ?? ""}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (!e.currentTarget.value)
                  patch(selected.id, { minCount: undefined });
                else if (
                  Number.isInteger(n) &&
                  n >= 1 &&
                  n <= 1000000
                )
                  patch(selected.id, {
                    minCount: withMinimum(selected.minCount, n),
                  });
              }}
            />
          </label>
          <label>
            Counting
            <select
              aria-label="Minimum counts"
              disabled={selected.minCount === undefined}
              value={minimumKey(selected.minCount)}
              onChange={(e) =>
                patch(selected.id, {
                  minCount: minimumOf(
                    e.target.value,
                    metricMinCount(selected) ?? 1,
                  ),
                })
              }
            >
              <option value="rows">Rows</option>
              {minimumChoices(
                measurable,
                selected.minCount,
                fieldLabel,
              ).map(([key, label]) => (
                <option key={key} value={key}
                  disabled={key !== minimumKey(selected.minCount) && !minimumAllowed(selected, key)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {selected.minCount !== undefined && (
        <p className="qt-metric-help">
          Groups below the minimum are hidden before ordering and
          the group limit; they are not added to Other.
          {metricMinCountMeasure(selected)
            ? " Distinct values and sums ignore empty values."
            : ""}
        </p>
      )}
    </Settings>
  );
}
