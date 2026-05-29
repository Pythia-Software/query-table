// @query-table/core — pure TS contracts shared by every consumer.
// No React, no DOM. Safe to import on a server, in a worker, or another stack.

export type {
  FilterOp,
  WhereClause,
  OrderByClause,
  SelectColumn,
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

export type { ServerQuery } from "./encode";
export { encodeQuery, decodeQuery, toServerQuery } from "./encode";

export type { ApplyResult } from "./apply";
export { applyQuery, matchesClause } from "./apply";

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
