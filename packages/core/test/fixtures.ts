// Shared test schema + rows, exercising every field kind.
import type { FieldSchema } from "../src/index";

export interface Run {
  id: number;
  case_name: string | null;
  platform: string;
  overall: "PASS" | "FAIL" | "DIFFERENCES" | null;
  total_ms: number | null;
  is_starred: boolean;
  error_codes: string[] | null;
}

export const runsSchema: FieldSchema<Run> = {
  name: "runs",
  idField: "id",
  defaultLimit: 100,
  defaultSort: [{ field: "total_ms", dir: "desc", nulls: "last" }],
  defaultSelect: [{ field: "case_name" }, { field: "overall" }, { field: "total_ms" }],
  fields: [
    { name: "id", label: "Run", type: "number", source: { kind: "backend" } },
    { name: "case_name", label: "Case", type: "text", source: { kind: "backend" }, select: { default: true } },
    { name: "platform", label: "Platform", type: "enum", source: { kind: "backend" }, filter: { values: { source: "static", options: ["windows", "macos"] } } },
    { name: "overall", label: "Overall", type: "enum", source: { kind: "backend" }, select: { default: true }, render: "overall_pill" },
    { name: "total_ms", label: "Total", type: "number", source: { kind: "backend" }, select: { default: true } },
    // synthetic backend field: server-filterable/sortable, sorts via a different key
    { name: "is_starred", label: "★", type: "bool", source: { kind: "backend", synthetic: true }, sort: { field: "is_starred" } },
    // backend-sourced VALUE but filtered client-side (no SQL binding) → pushdown:false
    { name: "error_codes", label: "Errors", type: "textarray", source: { kind: "backend" }, filter: { pushdown: false }, render: "code_tags" },
    // pure derived render-only column
    { name: "details", label: "Details", type: "text", source: { kind: "derived" }, sort: { enabled: false }, render: "detail_link" },
  ],
};

export const rows: Run[] = [
  { id: 1, case_name: "alpha", platform: "windows", overall: "PASS", total_ms: 120, is_starred: false, error_codes: null },
  { id: 2, case_name: "bravo", platform: "macos", overall: "FAIL", total_ms: 999, is_starred: true, error_codes: ["parse", "eval"] },
  { id: 3, case_name: "charlie", platform: "windows", overall: "FAIL", total_ms: null, is_starred: false, error_codes: ["eval"] },
  { id: 4, case_name: "delta", platform: "macos", overall: null, total_ms: 50, is_starred: true, error_codes: [] },
];
