import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyQuery,
  compileFormula,
  computedFieldName,
  groupPreview,
  isComputedField,
  memoryComputedColumnStore,
  readFieldValue,
  toServerQuery,
  validateComputedColumn,
  isSelectable,
  type ColumnPreview,
  type ComputedColumn,
  type ComputedColumnDraft,
  type ComputedColumnStore,
  type FieldDef,
  type FieldSchema,
  type FormulaPlan,
  type FormulaResult,
  type FormulaValue,
  type QueryState,
  type Transport,
} from "@pythia-software/query-table-core";
import {
  evaluateFormulaRows,
  type FormulaWorkerFactory,
} from "./formulaWorker";

export interface ComputedColumnsApi<Row> {
  definitions: ComputedColumn[];
  catalogue: FieldDef<Row>[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (
    column: ComputedColumnDraft,
    expectedRevision: string | null,
  ) => Promise<ComputedColumn>;
  compile: (source: string, editingId?: string) => FormulaPlan;
  /** Sample the first N matching rows in current sort order, independent of table paging. */
  preview: (
    source: string,
    count: number,
    signal?: AbortSignal,
    editingId?: string,
    includeInputs?: boolean,
  ) => Promise<ColumnPreview>;
}
interface Options<Row> {
  schema: FieldSchema<Row>;
  query: QueryState;
  rows: Row[];
  store?: ComputedColumnStore;
  transport?: Transport<Row>;
  clientRows?: Row[];
  workerFactory?: FormulaWorkerFactory;
}
export function useComputedColumns<Row>(options: Options<Row>): {
  api: ComputedColumnsApi<Row>;
  displaySchema: FieldSchema<Row>;
} {
  const { schema, query, rows, transport, clientRows, workerFactory } = options;
  const store = useMemo(
    () => options.store ?? memoryComputedColumnStore(),
    [options.store],
  );
  const [catalogue, setCatalogue] = useState<{
    dataset: string;
    store: ComputedColumnStore;
    items: ComputedColumn[];
  } | null>(null);
  const definitions = useMemo(
    () =>
      catalogue?.dataset === schema.name && catalogue.store === store
        ? catalogue.items
        : [],
    [catalogue, schema.name, store],
  );
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const catalogueRequest = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    catalogueRequest.current?.abort();
    const ac = new AbortController();
    catalogueRequest.current = ac;
    setLoading(true);
    setError(null);
    try {
      const items = await store.list(schema.name, ac.signal);
      if (ac.signal.aborted) return;
      const valid = items
        .map(validateComputedColumn)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(valid.map((c) => c.id)).size !== valid.length)
        throw new Error("Duplicate computed column IDs.");
      setCatalogue((previous) =>
        previous?.dataset === schema.name &&
        previous.store === store &&
        JSON.stringify(previous.items) === JSON.stringify(valid)
          ? previous
          : { dataset: schema.name, store, items: valid },
      );
    } catch (e) {
      if (!ac.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [store, schema.name]);
  useEffect(() => {
    void reload();
    return () => catalogueRequest.current?.abort();
  }, [reload]);
  useEffect(
    () =>
      store.subscribe?.(schema.name, () => {
        void reload();
      }),
    [store, schema.name, reload],
  );
  useEffect(() => {
    const focus = () => {
      void reload();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [reload]);
  const inputFields = useMemo(
    () =>
      schema.fields
        .filter(isSelectable)
        .filter(
          (f) =>
            f.source.kind === "backend" ||
            (f.source.accessor && f.source.dependencies),
        ),
    [schema],
  );
  const compile = useCallback(
    (source: string, editingId?: string): FormulaPlan => {
      const stack = new Set<string>(editingId ? [editingId] : []);
      let expanded = 0;
      const resolve = (name: string): FormulaPlan | undefined => {
        if (!isComputedField(name)) return undefined;
        const id = name.slice("@computed/".length),
          def = definitions.find((d) => d.id === id);
        if (!def) throw new Error(`Computed column unavailable: ${id}`);
        if (stack.has(id))
          throw new Error(`Circular computed-column reference: ${def.label}`);
        if (stack.size >= 20 || ++expanded > 100)
          throw new Error("Computed dependency graph is too large.");
        stack.add(id);
        try {
          return compileFormula(def.expression.source, inputFields, resolve);
        } finally {
          stack.delete(id);
        }
      };
      return compileFormula(source, inputFields, resolve);
    },
    [inputFields, definitions],
  );
  const plans = useMemo(
    () =>
      new Map<string, { plan?: FormulaPlan; error?: string }>(
        definitions.map((def) => {
          try {
            return [
              def.id,
              { plan: compile(def.expression.source, def.id) },
            ] as const;
          } catch (e) {
            return [
              def.id,
              { error: e instanceof Error ? e.message : String(e) },
            ] as const;
          }
        }),
      ),
    [definitions, compile],
  );
  const backendDependencies = useCallback(
    (plan: FormulaPlan) =>
      [
        ...new Set(
          plan.dependencies.flatMap((name) => {
            const f = inputFields.find((f) => f.name === name);
            return f?.source.kind === "backend"
              ? [name]
              : (f?.source.dependencies ?? []);
          }),
        ),
      ]
        .filter((name) =>
          schema.fields.some(
            (f) => f.name === name && f.source.kind === "backend",
          ),
        )
        .sort(),
    [schema, inputFields],
  );
  const inputsFor = useCallback(
    (plan: FormulaPlan, batch: Row[]) => {
      let size = 0;
      return batch.map((row) => {
        const values: Record<string, FormulaValue> = Object.create(null);
        for (const name of plan.dependencies) {
          const field = inputFields.find((f) => f.name === name)!;
          const raw = readFieldValue(field, row);
          values[name] =
            raw instanceof Date ? raw.toISOString() : (raw as FormulaValue);
        }
        size += JSON.stringify(values).length;
        if (size > 16000000)
          throw new Error(
            "Input sample exceeds 16 MB. Reduce the rows to process.",
          );
        return values;
      });
    },
    [inputFields],
  );
  const activeSelect = query.select.length
    ? query.select
    : (schema.defaultSelect ?? []);
  const activeIds = activeSelect
    .filter((c) => isComputedField(c.field))
    .map((c) => c.field.slice("@computed/".length))
    .sort()
    .join(",");
  const [evaluated, setEvaluated] = useState<{
    rows: Row[];
    plans: typeof plans;
    values: Map<string, FormulaResult[]>;
  } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const values = new Map<string, FormulaResult[]>();
    void (async () => {
      for (const id of activeIds.split(",").filter(Boolean)) {
        const entry = plans.get(id);
        if (!entry?.plan) continue;
        try {
          values.set(
            id,
            await evaluateFormulaRows(
              entry.plan.ast,
              inputsFor(entry.plan, rows),
              ac.signal,
              workerFactory,
            ),
          );
        } catch (e) {
          if (ac.signal.aborted) return;
          values.set(
            id,
            rows.map(() => ({
              value: null,
              error: e instanceof Error ? e.message : String(e),
            })),
          );
        }
      }
      if (!ac.signal.aborted) setEvaluated({ rows, plans, values });
    })();
    return () => ac.abort();
  }, [activeIds, rows, plans, inputsFor, workerFactory]);
  const displaySchema = useMemo<FieldSchema<Row>>(() => {
    const indices = new Map(rows.map((row, i) => [row, i]));
    const fields: FieldDef<Row>[] = definitions.map((def) => {
      const entry = plans.get(def.id);
      return {
        name: computedFieldName(def.id),
        label: def.label,
        type:
          entry?.plan?.type === "null" ? "text" : (entry?.plan?.type ?? "text"),
        group: "Computed columns",
        source: {
          kind: "derived",
          computedId: def.id,
          dependencies: entry?.plan ? backendDependencies(entry.plan) : [],
          accessor: (row: Row) => {
            if (entry?.error) return { computedError: entry.error };
            const result =
              evaluated?.rows === rows && evaluated.plans === plans
                ? evaluated.values.get(def.id)?.[indices.get(row) ?? -1]
                : undefined;
            return result?.error
              ? { computedError: result.error }
              : result
                ? result.value
                : { computedError: "Calculating…" };
          },
        },
        filter: { enabled: false },
        sort: { enabled: false },
        aggregate: { measure: false, groupable: false },
      };
    });
    for (const col of activeSelect)
      if (
        isComputedField(col.field) &&
        !fields.some((f) => f.name === col.field)
      )
        fields.push({
          name: col.field,
          label: col.field.slice(10),
          type: "text",
          source: {
            kind: "derived",
            computedId: col.field.slice(10),
            accessor: () => ({
              computedError: loading
                ? "Loading definition…"
                : "Definition unavailable. Reload the catalogue or contact its owner.",
            }),
          },
          filter: { enabled: false },
          sort: { enabled: false },
          aggregate: { measure: false, groupable: false },
        });
    return { ...schema, fields: [...schema.fields, ...fields] };
  }, [
    schema,
    definitions,
    plans,
    backendDependencies,
    evaluated,
    rows,
    query.select,
    schema.defaultSelect,
    loading,
  ]);
  const save = useCallback(
    async (column: ComputedColumnDraft, expectedRevision: string | null) => {
      compile(column.expression.source, column.id);
      const saved = validateComputedColumn(
        await store.save(schema.name, column, expectedRevision),
      );
      setCatalogue((prev) => ({
        dataset: schema.name,
        store,
        items: [
          ...(prev?.dataset === schema.name && prev.store === store
            ? prev.items.filter((d) => d.id !== saved.id)
            : []),
          saved,
        ],
      }));
      return saved;
    },
    [compile, store, schema.name],
  );
  const preview = useCallback(
    async (
      source: string,
      count: number,
      signal?: AbortSignal,
      editingId?: string,
      includeInputs = true,
    ): Promise<ColumnPreview> => {
      if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new Error("Choose between 1 and 10,000 rows.");
      const plan = compile(source, editingId);
      let batch: Row[] = [],
        total = 0;
      if (transport) {
        const request = toServerQuery(
          {
            ...query,
            select: [
              ...new Set([schema.idField, ...backendDependencies(plan)]),
            ].map((field) => ({ field })),
            limit: Math.min(count, 500),
            offset: 0,
          },
          schema,
        );
        while (batch.length < count) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const res = await transport.fetchRows(
            {
              ...request,
              offset: batch.length,
              limit: Math.min(500, count - batch.length),
            },
            signal,
          );
          total = res.total;
          batch.push(...res.rows.slice(0, count - batch.length));
          if (!res.rows.length || batch.length >= total) break;
        }
      } else {
        const result = applyQuery(
          clientRows ?? [],
          { ...query, limit: count, offset: 0 },
          schema,
        );
        batch = result.rows;
        total = result.total;
      }
      const inputs = inputsFor(plan, batch),
        results = await evaluateFormulaRows(
          plan.ast,
          inputs,
          signal,
          workerFactory,
        );
      return groupPreview(
        includeInputs ? plan.dependencies : [],
        inputs,
        results,
        total,
      );
    },
    [
      compile,
      transport,
      query,
      schema,
      backendDependencies,
      clientRows,
      inputsFor,
      workerFactory,
    ],
  );
  return {
    displaySchema,
    api: {
      definitions,
      catalogue: displaySchema.fields,
      loading,
      error,
      reload,
      save,
      compile,
      preview,
    },
  };
}
