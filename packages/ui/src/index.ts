// @pythia-software/query-table-ui — the opinionated, themeable components.
// Bring your own theme: import "@pythia-software/query-table-ui/theme.css" (Mode A) or pass
// `classNames` slots (Mode B).

export type { CellContext, CellRenderer, RenderRegistry } from "./renderers";
export { Icon } from "./Icon";
export type { IconName, IconProps } from "./Icon";
export { defaultRenderers, resolveRenderer, safeLinkHref } from "./renderers";
export { JsonCell, JsonValueView } from "./JsonCell";
export type { JsonCellProps } from "./JsonCell";
export { inspectJsonValue, searchJsonEntries } from "./jsonValue";
export type { JsonInspection, JsonEntry } from "./jsonValue";

export type { TableClassNames, QueryBuilderClassNames, MenuClassNames } from "./classNames";

export type { DataTableProps } from "./DataTable";
export { DataTable } from "./DataTable";

export type { QueryBuilderProps, SelectPresentation } from "./QueryBuilder";
export { QueryBuilder, QueryFilterRow } from "./QueryBuilder";

export type { MetricsPanelProps } from "./MetricsPanel";
export { MetricsPanel, MetricCard } from "./MetricsPanel";

export type { FieldPickerProps } from "./FieldPicker";
export { FieldPicker } from "./FieldPicker";

export type { CellMenuProps } from "./CellMenu";
export { CellMenu } from "./CellMenu";

export type { SelectionToolbarProps } from "./SelectionToolbar";
export { SelectionToolbar } from "./SelectionToolbar";

export type { SavedQueriesModalProps } from "./SavedQueriesModal";
export { SavedQueriesModal } from "./SavedQueriesModal";

export { SelectColumnEditor } from "./SelectColumnEditor";
export type { SelectColumnEditorProps } from "./SelectColumnEditor";

export { FilterValueProvider, PresentedFilterValue } from "./FilterValuePresentation";
export type { FilterValuePresentation } from "./FilterValuePresentation";

export { MetricsEditor } from "./MetricsEditor";
export type { MetricsEditorProps } from "./MetricsEditor";
export type { MetricCardProps } from "./MetricsPanel";
export { createMetricColorResolver } from "./metricColors";
export type { MetricTheme, MetricClassNames } from "./metricColors";
export { formatMetricOutput, validateMetricFormat, metricTimestamp } from "./metricFormat";

export { RequestActivity } from "./RequestActivity";
export type { RequestActivityProps } from "./RequestActivity";
export { ObjectProperties, formatPropertyValue } from "./ObjectProperties";
export type { ObjectPropertiesProps } from "./ObjectProperties";
export { PropertyViewEditor, PropertyViewControls } from "./PropertyViewEditor";
export { ObjectInspector } from "./ObjectInspector";
export { ItemDetailShare, itemDetailHref } from "./ItemDetails";
export type { ObjectInspectorProps } from "./ObjectInspector";

export { Menu, MenuButton, MenuGroup, MenuItem, MenuSubmenu, MenuSeparator } from "./Menu";
export type { MenuAnchor, MenuProps, MenuItemProps, MenuSubmenuProps, MenuButtonProps, MenuGroupProps } from "./Menu";

export { Popover } from "./Popover";
export type { PopoverProps } from "./Popover";

export { PickerAnchor, PickerSurface } from "./PickerAnchor";
export { EditorContext, EditorPaneTitle, EditorChoice } from "./EditorParts";
export { ModalSurface, useMobileLayout } from "./AdaptiveOverlay";
export { ReorderList } from "./ReorderList";

export { EditorModal, EditorPanelToggle, EditorPanelSeparator, type EditorWorkbench } from "./EditorModal";
export { useEditorWorkbench, type EditorPaneSize } from "./useEditorWorkbench";

export { default as FormulaEditor, type FormulaEditorProps, type FormulaEditorActions } from "./FormulaEditor";
export { FormulaFunctionBrowser } from "./FormulaFunctionBrowser";
export { ColumnRoleBadge, type ColumnRole } from "./ColumnRoleBadge";

export { GroupedColumnsEditor } from "./grouping/GroupedColumnsEditor";
