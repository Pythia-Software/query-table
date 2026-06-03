// @query-table/core — pure TS contracts shared by every consumer.
// No React, no DOM. Safe to import on a server, in a worker, or another stack.

export type {
  FilterOp,
  WhereClause,
  OrderByClause,
  SelectColumn,
  AggOp,
  AggregationClause,
  QueryState,
  RowId,
} from "./query";
export { EMPTY_QUERY, queriesEqual } from "./query";

export type {
  FieldType,
  Align,
  CellRenderer,
  FieldSource,
  BackendField,
  DerivedField,
  FilterValues,
  FilterConfig,
  SortConfig,
  SelectConfig,
  AggregateConfig,
  FieldDef,
  FieldSchema,
} from "./schema";
export {
  isFilterable,
  isPushdownFilter,
  isSortable,
  isSelectable,
  filterValues,
  indexFields,
  selectedFields,
  readFieldValue,
  loadSchema,
} from "./schema";

export { OPS_BY_TYPE, NULLARY_OPS, opsForField, opAllowedForType, coerceValue } from "./ops";
export {
  AGG_OPS_BY_TYPE,
  AGG_OPS_NEEDING_FIELD,
  aggOpNeedsField,
  aggOpsForField,
  aggOpAllowedForType,
  isMeasurable,
  isGroupable,
} from "./agg";

export type {
  ServerQuery,
  AggregationRequest,
  AggregationBucket,
  AggregationResultEntry,
  AggregationResult,
} from "./encode";
export { encodeQuery, decodeQuery, toServerQuery, toAggregationQuery } from "./encode";

export type { ApplyResult } from "./apply";
export { applyQuery, matchesClause, applyAggregations } from "./apply";

export type {
  FetchRowsResult,
  DistinctValuesQuery,
  DistinctValuesResult,
  FieldStats,
  Transport,
  SavedQuery,
  StorageAdapter,
} from "./adapters";
export { localStorageAdapter } from "./adapters";
