/** Core owns computation and serialized presentation types. These aliases keep rendering imports focused. */
import type {
  AggregationBucket,
  AggregationClause,
  AggregationResultEntry,
} from "@pythia-software/query-table-core";
export type {
  MetricValue,
  MetricValueFormat,
  MetricDisplay,
  MetricBoxSummary as BoxSummary,
  MetricDistributionResult as MetricDistribution,
} from "@pythia-software/query-table-core";
export type MetricBucket = AggregationBucket;
export type RenderingClause = AggregationClause;
/** Optional exact remainder for transports that truncate additive groups. */
export type MetricRenderResult = Pick<
  AggregationResultEntry,
  "buckets" | "error" | "groupCount" | "coverage" | "scope" | "processedRows"
> & { other?: AggregationBucket };
