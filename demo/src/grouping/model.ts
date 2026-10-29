// Sample data and legacy view migration only. Execution lives in the library.
import {
  createGroupingModel, loadSchema, normalizeQueryState, OP_LABEL, MAX_REPRESENTATIVE_SORTS,
  type GroupedRow, type GroupingView, type SummaryOp, type SummaryColumn,
  type RepresentativeRow, type QueryState, type SavedQuery,
} from "@pythia-software/query-table-core";
import runsDoc from "../../../schema/examples/runs.schema.json";
import { RUNS } from "../data";
export type Row = GroupedRow;
export type View = GroupingView;
export type { SummaryOp, SummaryColumn, RepresentativeRow };
export { OP_LABEL, MAX_REPRESENTATIVE_SORTS };
export interface SavedView extends SavedQuery { view: View }
export const inputSchema = loadSchema<Row>(runsDoc);
inputSchema.name = "grouping-library-input";
// The fixture is flat, unlike the Go demo's nullable timestamp shape.
inputSchema.fields = inputSchema.fields
  .filter((f) => f.source.kind === "backend")
  .map((f) => ({
    ...f,
    source: { kind: "backend" },
    ...(f.name === "total_ms" ? { label: "Duration" } : {}),
  }));
// Keep the existing fixture, including null durations, shared with the main demo.
export const inputRows: Row[] = RUNS.map((row) => ({ ...row }));

const model = createGroupingModel(inputSchema);
export const { sourceField, groupableFields, summaryFields, representativeFields,
  representativeLabel, allowedOps, summaryExpression, summaryProblem, summaryLabel,
  resultSchema, groupRows, filteredInput, reconcileRepresentative } = model;

export function queryFromView(view: View): QueryState {
  return normalizeQueryState(view.mode === "rows" ? view.input : {
    ...view.result,
    grouping: { keys: view.groupKeys ?? view.keys, summaries: view.summaries, representative: view.representative, source: view.input },
  });
}

const emptyQuery = (): QueryState =>
  normalizeQueryState({
    select: [],
    where: [],
    orderBy: [],
    limit: 25,
    offset: 0,
  });
export function initialView(): View {
  return {
    version: 2,
    mode: "rows",
    keys: [],
    summaries: [],
    representative: null,
    input: {
      ...emptyQuery(),
      select: inputSchema.defaultSelect ?? [],
      orderBy: inputSchema.defaultSort ?? [],
      aggregations: [
        {
          id: "runs",
          op: "count",
          groupBy: [],
          expression: "COUNT()",
          label: "Matching runs",
          display: { kind: "value" },
        },
      ],
    },
    result: emptyQuery(),
  };
}
export function seedViews(): SavedView[] {
  const rows = initialView();
  const platforms: View = {
    ...initialView(),
    mode: "groups",
    keys: ["platform"],
    summaries: [
      { id: "run_count", op: "count" },
      { id: "avg_duration", op: "avg", field: "total_ms" },
      { id: "max_duration", op: "max", field: "total_ms" },
    ],
    result: {
      ...emptyQuery(),
      select: ["platform", "run_count", "avg_duration", "max_duration"].map(
        (field) => ({ field }),
      ),
      orderBy: [{ field: "avg_duration", dir: "desc" }],
      aggregations: [
        {
          id: "groups",
          op: "count",
          groupBy: [],
          expression: "COUNT()",
          label: "Platforms after HAVING",
          display: { kind: "value" },
        },
      ],
    },
  };
  const workers: View = {
    ...initialView(),
    mode: "groups",
    keys: ["worker"],
    representative: {
      orderBy: [{ field: "total_ms", dir: "desc", nulls: "last" }],
    },
    summaries: [
      { id: "run_count", op: "count" },
      { id: "avg_duration", op: "avg", field: "total_ms" },
      { id: "example_id", op: "row", field: "id" },
      { id: "example_job", op: "row", field: "job_name" },
    ],
    result: {
      ...emptyQuery(),
      select: [
        "worker",
        "run_count",
        "avg_duration",
        "example_id",
        "example_job",
      ].map((field) => ({ field })),
      where: [{ field: "run_count", op: ">=", value: "10" }],
      orderBy: [{ field: "run_count", dir: "desc" }],
      aggregations: [
        {
          id: "groups",
          op: "count",
          groupBy: [],
          expression: "COUNT()",
          label: "Workers after HAVING",
          display: { kind: "value" },
        },
      ],
    },
  };
  const examples: [string, string, View][] = [
    ["runs", "Individual runs", rows],
    ["platforms", "Duration by platform", platforms],
    ["workers", "Busy workers", workers],
  ];
  return examples.map(([id, name, raw]) => {
    const view = parseView(raw);
    return {
      id,
      name,
      savedAt: Date.UTC(2026, 9, 12),
      view,
      query: view.mode === "rows" ? view.input : view.result,
    };
  });
}

/** Check the demo envelope before restoring local storage or a share URL. */
export function parseView(raw: unknown): View {
  if (!raw || typeof raw !== "object") throw new Error("Invalid view");
  type LegacyView = Omit<View, "version" | "summaries" | "representative"> & {
    version: 1;
    summaries: (Omit<SummaryColumn, "op"> & {
      op: SummaryOp | "latest" | "longest";
    })[];
  };
  const v = raw as View | LegacyView;
  if (
    ![1, 2].includes(v.version) ||
    !["rows", "groups"].includes(v.mode) ||
    !Array.isArray(v.keys) ||
    v.keys.length > groupableFields.length ||
    !Array.isArray(v.summaries) ||
    v.summaries.length > 64
  )
    throw new Error("Invalid view structure");
  if (v.version === 1) {
    const rules = new Set(
      v.summaries
        .map((s) => s?.op)
        .filter((op) => op === "latest" || op === "longest"),
    );
    if (rules.size > 1)
      throw new Error(
        "This older view uses both latest and longest rows. Choose one representative ordering before importing it.",
      );
    const rule = [...rules][0];
    return parseView({
      ...v,
      version: 2,
      representative: rule
        ? {
            orderBy: [
              {
                field: rule === "latest" ? "enqueued_at" : "total_ms",
                dir: "desc",
                nulls: "last",
              },
            ],
          }
        : null,
      summaries: v.summaries.map((s) => ({
        ...s,
        op: s.op === "latest" || s.op === "longest" ? "row" : s.op,
      })),
    });
  }
  if (
    new Set(v.keys).size !== v.keys.length ||
    v.keys.some((key) => !groupableFields.some((f) => f.name === key)) ||
    (v.mode === "groups" && !v.keys.length)
  )
    throw new Error("Invalid group keys");
  const ids = new Set(inputSchema.fields.map((f) => f.name));
  ids.add("__group_id");
  for (const c of v.summaries) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(c.id) ||
      ids.has(c.id) ||
      (c.op === "formula"
        ? typeof c.expression !== "string" ||
          Boolean(summaryProblem(c)) ||
          (c.label !== undefined &&
            (typeof c.label !== "string" || c.label.length > 1000)) ||
          (c.field !== undefined && !sourceField(c.field))
        : !allowedOps(c.field).includes(c.op))
    )
      throw new Error("Invalid summary");
    ids.add(c.id);
  }
  const representative = parseRepresentative(v.representative);
  if (!representative && v.summaries.some((s) => s.op === "row"))
    throw new Error("Row columns require representative-row ordering.");
  if (!v.input || !v.result) throw new Error("Missing query");
  return {
    version: 2,
    mode: v.mode,
    keys: [...v.keys],
    summaries: v.summaries.map((c) => ({
      id: c.id,
      op: c.op,
      ...(c.field ? { field: c.field } : {}),
      ...(c.op === "formula"
        ? {
            expression: c.expression!,
            ...(c.label !== undefined ? { label: c.label } : {}),
          }
        : {}),
    })),
    representative,
    input: normalizeQueryState(v.input),
    result: normalizeQueryState(v.result),
  };
}

export function parseRepresentative(raw: unknown): RepresentativeRow | null {
  if (raw == null) return null;
  const rule = raw as RepresentativeRow;
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== "orderBy") ||
    !Array.isArray(rule.orderBy) ||
    !rule.orderBy.length ||
    rule.orderBy.length > MAX_REPRESENTATIVE_SORTS
  )
    throw new Error(
      "Choose at least one representative sort field (up to eight).",
    );
  const seen = new Set<string>();
  for (const term of rule.orderBy) {
    if (
      !term ||
      typeof term !== "object" ||
      Object.keys(term).some(
        (key) => !["field", "dir", "nulls"].includes(key),
      ) ||
      !representativeFields.some((field) => field.name === term.field) ||
      seen.has(term.field) ||
      !["asc", "desc"].includes(term.dir) ||
      (term.nulls !== undefined && !["first", "last"].includes(term.nulls))
    )
      throw new Error("Invalid representative-row ordering.");
    seen.add(term.field);
  }
  return {
    orderBy: rule.orderBy.map((term) => ({
      field: term.field,
      dir: term.dir,
      nulls: term.nulls ?? "last",
    })),
  };
}
