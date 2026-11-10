// @pythia-software/query-table-core — pure TS contracts shared by every consumer.
// No React, no DOM. Safe to import on a server, in a worker, or another stack.

export type {
  FilterOp,
  WhereClause,
  OrGroup,
  OrOfAndsGroup,
  WhereConjunction,
  WhereBranch,
  WhereTerm,
  OrderByClause,
  SelectColumn,
  AggOp,
  AggregationClause,
  QueryState,
  FitMode,
  ItemDetailMode,
  ItemPropertyMode,
  ItemPageOptions,
  ItemDetailsState,
  RowId,
  HostQueryState,
} from "./query";
export { itemPageFields, validateItemPageTemplate, renderItemPageTemplate } from "./itemPage";
export {
  ITEM_DETAILS_COLUMN,
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
  isOrGroup,
  isOrOfAndsGroup,
  isWhereConjunction,
  isWhereGroup,
  predicatesOf,
  branchesOf,
  parseHostQueryState,
  MAX_HOST_QUERY_PARAMS,
  MAX_HOST_QUERY_VALUES,
  MAX_HOST_QUERY_VALUE_LENGTH,
  MAX_HOST_QUERY_STATE_BYTES,
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
export type { CellDisplay, JsonCellDisplay } from "./cellDisplay";
export {
  isFilterable,
  isPushdownFilter,
  isSortable,
  isSelectable,
  filterValues,
  indexFields,
  selectedFields,
  readFieldValue,
  resolveFieldName,
  loadSchema,
} from "./schema";

export { OPS_BY_TYPE, NULLARY_OPS, opsForField, opAllowedForType, coerceValue, negateClause, isNegativePredicate, opPairsForField } from "./ops";
export type { OpChoice, OpPair } from "./ops";
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
  AggregationBucket,
  AggregationResultEntry,
  AggregationResult,
} from "./encode";
export { encodeQuery, decodeQuery, decodeQueryStrict, QueryDecodeError, MAX_QUERY_STATE_BYTES, toServerQuery } from "./encode";
export * from "./queryLinks";
export * from "./errors";

export type { ApplyResult } from "./apply";
export { applyQuery, matchesClause, applyAggregations } from "./apply";

export type {
  DistinctValuesResult,
  FieldStats,
  Transport,
  SavedQuery,
  StorageAdapter,
} from "./adapters";
export { localStorageAdapter, memoryStorageAdapter } from "./adapters";

export * from "./formula";
export * from "./computed";
export * from "./setFilter";
export type { SetFilterMetadata, SetFilterMode } from "./query";

export { parseRelativeDuration, MAX_RELATIVE_TIME_MS } from "./relativeTime";
export type { QueryEvaluationOptions } from "./relativeTime";

export * from "./metricTypes";
// Wire-only shapes of the v3 protocol (schema/query-wire.schema.json).
export type {
  MetricSpecV3, MetricBucketV3, MetricResultV3, MetricDisplayHint, MetricMinCount, MetricMinCountDistinct, MetricMinCountSum,
  MetricBoxDistribution, MetricHistogramDistribution, ProjectedSchemaV3, ProjectedFieldV3, RegexExtract,
  WireWhereClause, WireWhereConjunction, WireWhereBranch, WireOrGroup, WireWhereTerm, WireMetricDateGrouping, WireMetricSort,
  WireSummaryColumn, WireRepresentativeRow, WireGroupingDefinition,
} from "./wire.generated";
export {
  METRIC_FUNCTIONS,
  compileMetric,
  metricAggregatePlans,
  reduceMetricValues,
  evaluateMetricReductions,
  metricExpression,
  hasRegex,
  occurrenceDistribution,
  metricPlans,
  validateMetric,
  metricMinCount,
  metricMinCountMeasure,
  metricMinCountText,
  metricMinCountPlan,
  metricMinCountKeeps,
  metricPopulationError,
  metricDependencies,
  metricComputationKey,
  selectMetricShownRows,
  compareMetricValues,
  sortMetricBuckets,
  evaluateMetrics,
  metricOtherRemainder,
} from "./metrics";
export type { MetricPlan, MetricReductionOptions, MetricPopulationSupport, MetricEvaluationOptions } from "./metrics";
export * from "./metricDistributions";
export * from "./metricDates";
export * from "./metricSeries";
export * from "./metricIntervals";
export * from "./properties";
export * from "./propertyStorage";
export * from "./grouping";
export {
  GROUP_KEY_INTERVALS,
  isCalendarGroupKey,
  groupKeyField,
  groupKeyFields,
  calendarGroupKey,
  groupKeyTerms,
  type CalendarGroupKey,
  type GroupKey,
} from "./groupKeys";
export * from "./source";
export * from "./queryV3";
export { inspectBucketQuery, groupSourceQuery } from "./drilldown";
export { groupLinkQuery, resolveGroupLink, withoutLinkSummaries } from "./groupLinks";
export type { LinkTargets, ResolvedGroupLink } from "./groupLinks";
export { applyPatch, matchPatch, removePatch } from "./queryPatch";
export type { QueryFacet, QueryPatch, QueryPatchMatch, ApplyPatchOptions } from "./queryPatch";

export * from "./jsonInspection";
export * from "./attention";
