// Metrics row: the Add metric entry point that opens the MetricsEditor workbench.

import { MetricsEditor } from "../MetricsEditor";
import type { MetricTheme } from "../metricColors";
import {
  useMemo,
  useState,
} from "react";
import type { FieldDef } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { Icon } from "../Icon";

// Metrics authoring lives in a single transactional workbench.
export function MetricsRow<Row>({
  api,
  fields,
  theme,
  locale,
}: {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  theme: MetricTheme | undefined;
  locale: string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const allFields = useMemo(
    () => [
      ...fields,
      ...api.computed.catalogue.filter(
        (f) => !fields.some((existing) => existing.name === f.name),
      ),
    ],
    [fields, api.computed.catalogue],
  );
  return (
    <>
      {api.aggregations.clauses.length === 0 && (
        <div className="qt-qb-row qt-qb-row--metrics qt-qb-row--unused">
          <div className="qt-qb-section-header">
            <span className="qt-qb-kw" data-mobile-label="Metrics">
              metrics
            </span>
            <button
              type="button"
              className="qt-add qt-metrics-open"
              aria-label="Add metric"
              aria-haspopup="dialog"
              onClick={() => setEditing(true)}
            >
              <Icon name="add" />
              add metric
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
        </div>
      )}
      {editing && (
        <MetricsEditor
          api={api}
          fields={allFields}
          onClose={() => setEditing(false)}
          {...(theme ? { theme } : {})}
          {...(locale ? { locale } : {})}
        />
      )}
    </>
  );
}
