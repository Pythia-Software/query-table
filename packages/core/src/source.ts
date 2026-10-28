import { predicatesOf, ITEM_DETAILS_COLUMN, type QueryState } from "./query";
import { metricDependencies, compileMetric } from "./metrics";
import { createGroupingModel } from "./grouping";
import { groupKeyFields } from "./groupKeys";
import type { FieldSchema } from "./schema";
import type { FormulaPlan } from "./formula";

export interface SourceDependencies {
  fields: string[];
  baseFields: string[];
  identity: string;
  paths: Record<string, string>;
}
/** Source inputs are distinct from result/HAVING aliases. Includes hidden ROW
 * inputs and transitive computed/derived dependencies, even when not selected. */
export function sourceDependencies<Row>(query: QueryState, schema: FieldSchema<Row>, resolveComputed?: (name: string) => FormulaPlan | undefined): SourceDependencies {
  const fields = new Set<string>([schema.idField]);
  const addSort = (name: string) => {
    fields.add(name);
    const sortField = schema.fields.find(field => field.name === name)?.sort?.field;
    if (sortField) fields.add(sortField);
  };
  const source = query.grouping?.source ?? query;
  for (const term of source.where) for (const predicate of predicatesOf(term)) fields.add(predicate.field);
  if (query.grouping) {
    const model = createGroupingModel(schema);
    model.validate(query.grouping);
    for (const key of groupKeyFields(query.grouping.keys)) fields.add(key);
    for (const summary of query.grouping.summaries) {
      // Link columns read result fields only; they have no source inputs.
      if (summary.op === "link") continue;
      if (summary.op === "row") fields.add(summary.field!);
      else for (const dependency of compileMetric(model.summaryExpression(summary), schema, resolveComputed).dependencies) fields.add(dependency);
    }
    for (const term of query.grouping.representative?.orderBy ?? []) addSort(term.field);
  } else {
    for (const column of source.select) if (column.field !== ITEM_DETAILS_COLUMN) fields.add(column.field);
    for (const term of source.orderBy) addSort(term.field);
    for (const metric of source.aggregations ?? []) for (const dependency of metricDependencies(metric, schema, resolveComputed)) fields.add(dependency);
  }
  const base = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw Error("Source dependency cycle.");
    const field = schema.fields.find(field => field.name === name);
    if (!field && name === schema.idField) { base.add(name); return; }
    const dependencies = field?.source.kind === "derived" ? field.source.dependencies : resolveComputed?.(name)?.dependencies;
    if (!field && !dependencies) throw Error(`Unavailable source dependency: ${name}.`);
    if (dependencies?.length) {
      visiting.add(name);
      for (const dependency of dependencies) visit(dependency);
      visiting.delete(name);
    } else base.add(name);
  };
  for (const name of fields) visit(name);
  const paths = Object.fromEntries([...base].map(name => {
    const field = schema.fields.find(field => field.name === name);
    return [name, field?.source.kind === "backend" ? field.source.path ?? name : name];
  }));
  return { fields: [...fields].sort(), baseFields: [...base].sort(), identity: schema.idField, paths };
}
