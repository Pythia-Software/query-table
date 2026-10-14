import type { DuckDBConnection, DuckDBRow } from "./backend";

/** Structural adapter keeps duckdb-wasm optional and out of native bundles. */
export interface DuckDBWasmConnection {
  query(sql: string): Promise<{ toArray(): { toJSON(): unknown }[] }>;
  prepare(sql: string): Promise<{
    query(...args: any[]): Promise<{ toArray(): { toJSON(): unknown }[] }>;
    close(): Promise<void>;
  }>;
}
export function fromDuckDBWasmConnection(
  connection: DuckDBWasmConnection,
): DuckDBConnection {
  return {
    async query(sql, args) {
      if (!args.length)
        return (await connection.query(sql))
          .toArray()
          .map((row) => row.toJSON() as DuckDBRow);
      const statement = await connection.prepare(sql);
      try {
        return (await statement.query(...args))
          .toArray()
          .map((row) => row.toJSON() as DuckDBRow);
      } finally {
        await statement.close();
      }
    },
  };
}
