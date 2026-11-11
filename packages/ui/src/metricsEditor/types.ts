// Public props of the MetricsEditor workbench (re-exported by ../MetricsEditor).
import { type FieldDef } from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { type MetricTheme } from "../metricColors";

export interface MetricsEditorProps<Row> {
  api: QueryTableApi<Row>;
  fields: FieldDef<Row>[];
  onClose: () => void;
  initialMetricId?: string;
  initialView?: "editor" | "dashboard";
  theme?: MetricTheme;
  locale?: string;
}
