// classNames.ts — the styling escape hatch.
//
// Two ways to skin the components (decision: support both projects' looks):
//   - Mode A (drop-in): import "@query-table/ui/theme.css" and override CSS
//     variables. xplo-perf's plain-CSS palette becomes the default theme.
//   - Mode B (Tailwind/bespoke): pass a `classNames` slot map and skip the
//     stylesheet. xlsx-collect passes its Tailwind utility strings here.
//
// Components apply BOTH their structural class (`qt-*`, for Mode A) and any
// matching slot string (for Mode B), so the two modes compose.

export interface TableClassNames {
  wrap?: string;
  table?: string;
  thead?: string;
  headerRow?: string;
  th?: string;
  resizeHandle?: string;
  tbody?: string;
  row?: string;
  rowSelected?: string;
  cell?: string;
  checkboxCell?: string;
  loadingBar?: string;
  empty?: string;
  summaryRow?: string;
  summaryCell?: string;
  summaryControls?: string;
  summaryHint?: string;
  summaryButton?: string;
}

export interface QueryBuilderClassNames {
  root?: string;
  chip?: string;
  columnChip?: string;
  button?: string;
  input?: string;
  select?: string;
}

export interface MenuClassNames {
  popover?: string;
  item?: string;
  separator?: string;
}
