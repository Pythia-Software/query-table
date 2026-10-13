import { useEditorWorkbench } from "./useEditorWorkbench";

const panes = [
  { width: 240, minWidth: 180 },
  { width: 390, minWidth: 300 },
  { width: 250, minWidth: 200 },
  { width: 460, minWidth: 280 },
];

/** Metric-specific defaults for the shared editor layout. */
export function useMetricWorkbench(isEditor = true) {
  return useEditorWorkbench(panes, isEditor);
}
