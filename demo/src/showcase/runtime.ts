import * as duckdb from "@duckdb/duckdb-wasm";
import {
  DuckDBBackend,
  fromDuckDBWasmConnection,
} from "@pythia-software/query-table-duckdb";
import type { Dataset, DatasetManifest } from "./data";
import type { ComputedColumn } from "@pythia-software/query-table-core";

const base = () => new URL(import.meta.env.BASE_URL, window.location.href);
let database: Promise<duckdb.AsyncDuckDB> | undefined;
function engine(): Promise<duckdb.AsyncDuckDB> {
  if (!database)
    database = (async () => {
      const bundle = await duckdb.selectBundle({
        mvp: {
          mainModule: new URL("duckdb/duckdb-mvp.wasm", base()).href,
          mainWorker: new URL("duckdb/duckdb-browser-mvp.worker.js", base())
            .href,
        },
        eh: {
          mainModule: new URL("duckdb/duckdb-eh.wasm", base()).href,
          mainWorker: new URL("duckdb/duckdb-browser-eh.worker.js", base())
            .href,
        },
      });
      const worker = new Worker(bundle.mainWorker!);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      try {
        await db.instantiate(bundle.mainModule);
        await db.open({
          query: { castBigIntToDouble: false, castTimestampToDate: true },
          maximumThreads: 1,
        });
        return db;
      } catch (error) {
        worker.terminate();
        database = undefined;
        throw error;
      }
    })();
  return database;
}
export interface LoadedDataset {
  backend: DuckDBBackend;
  manifest: DatasetManifest;
  loadMs: number;
  createBackend(
    columns: ComputedColumn[],
  ): Promise<{ backend: DuckDBBackend; dispose(): Promise<void> }>;
  dispose(): Promise<void>;
}
export async function loadDataset(
  dataset: Dataset,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<LoadedDataset> {
  const start = performance.now();
  progress("Starting the browser query engine…");
  const manifestResponse = await fetch(
    new URL(`data/${dataset.id}.json`, base()),
    { signal },
  );
  if (!manifestResponse.ok)
    throw Error(
      `Dataset manifest failed to load (${manifestResponse.status}).`,
    );
  const manifest = (await manifestResponse.json()) as DatasetManifest;
  if (
    manifest.id !== dataset.id ||
    !Number.isSafeInteger(manifest.rows) ||
    !Number.isSafeInteger(manifest.bytes) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.file !== `${dataset.id}.parquet`
  )
    throw Error("Dataset manifest is invalid.");
  progress(
    `Loading ${manifest.rows.toLocaleString()} ${dataset.noun} · ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB…`,
  );
  const [db, response] = await Promise.all([
    engine(),
    fetch(new URL(`data/${manifest.file}`, base()), { signal }),
  ]);
  if (!response.ok)
    throw Error(`Dataset download failed (${response.status}).`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== manifest.bytes)
    throw Error("Dataset size differs from its snapshot manifest.");
  const hash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== manifest.sha256)
    throw Error(
      "Dataset integrity check failed. Reload to fetch the current snapshot.",
    );
  signal.throwIfAborted();
  progress("Preparing the table and its metrics…");
  const connection = await db.connect();
  const file = `${dataset.id}-${crypto.randomUUID()}.parquet`;
  const relation = `records_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await db.registerFileBuffer(file, new Uint8Array(buffer));
    // Bundle extensions on the same static origin; DuckDB otherwise fetches
    // ICU/Parquet/JSON from its public repository when first needed.
    await connection.query(
      `SET custom_extension_repository='${new URL("duckdb/extensions", base()).href.replace(/'/g, "''")}'`,
    );
    await connection.query("SET TimeZone='UTC'");
    await connection.query(
      `CREATE TABLE ${relation} AS SELECT * FROM '${file}'`,
    );
    await db.dropFile(file);
    signal.throwIfAborted();
    const backend = new DuckDBBackend({
      connection: fromDuckDBWasmConnection(connection),
      schema: dataset.schema,
      relation,
      maxPopulation: 100000,
      maxGroups: 10000,
    });
    let disposed = false;
    const resources = new Set<{
      backend: DuckDBBackend;
      dispose(): Promise<void>;
    }>();
    return {
      backend,
      manifest,
      loadMs: performance.now() - start,
      async createBackend(columns) {
        if (disposed) throw Error("The dataset has closed.");
        // Separate connections keep each immutable formula handshake's staging
        // tables isolated while an older request finishes or is cancelled.
        const nextConnection = await db.connect();
        try {
          await nextConnection.query("SET TimeZone='UTC'");
          if (disposed) throw Error("The dataset has closed.");
          const next = new DuckDBBackend({
            ...backend.options,
            connection: fromDuckDBWasmConnection(nextConnection),
            computedColumns: columns,
          });
          let closing: Promise<void> | undefined;
          const resource = {
            backend: next,
            dispose() {
              return (closing ??= (async () => {
                await next.drain();
                await nextConnection.close();
                resources.delete(resource);
              })());
            },
          };
          resources.add(resource);
          return resource;
        } catch (error) {
          await nextConnection.close();
          throw error;
        }
      },
      async dispose() {
        disposed = true;
        await Promise.all([...resources].map((resource) => resource.dispose()));
        await backend.drain();
        await connection.query(`DROP TABLE IF EXISTS ${relation}`);
        await connection.close();
      },
    };
  } catch (error) {
    await connection.query(`DROP TABLE IF EXISTS ${relation}`).catch(() => {});
    await connection.close();
    await db.dropFile(file).catch(() => {});
    throw error;
  }
}
