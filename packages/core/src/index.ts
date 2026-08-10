// @pythia-software/query-table-core — pure TS contracts shared by every consumer.
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
export {
  EMPTY_QUERY,
  MAX_QUERY_LIMIT,
  MAX_QUERY_OFFSET,
  MAX_SELECT_COLUMNS,
  MAX_WHERE_CLAUSES,
  MAX_ORDER_BY_TERMS,
  MAX_AGGREGATIONS,
  MAX_GROUP_BY_FIELDS,
  MAX_QUERY_TOKEN_LENGTH,
  normalizeQueryState,
  queriesEqual,
} from "./query";

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
export { localStorageAdapter, memoryStorageAdapter } from "./adapters";
