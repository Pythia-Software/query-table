import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url),
  root = fileURLToPath(new URL("../../", import.meta.url));
const lockPath = resolve(root, "demo/duckdb-runtime.json"),
  lock = JSON.parse(await readFile(lockPath, "utf8"));
const runtimeDirectory = dirname(
  require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"),
);
const installed = JSON.parse(
  await readFile(resolve(runtimeDirectory, "../package.json"), "utf8"),
);
if (installed.version !== lock.packageVersion)
  throw Error(
    "DuckDB-Wasm changed. Update and verify demo/duckdb-runtime.json before building.",
  );
const record = process.argv.includes("--record"),
  assets = [];
for (const platform of ["wasm_eh", "wasm_mvp"])
  for (const extension of ["icu", "parquet", "json"]) {
    const path = `${lock.engineVersion}/${platform}/${extension}.duckdb_extension.wasm`;
    const url = `https://extensions.duckdb.org/${path}`,
      cached = resolve(root, ".context/duckdb-runtime", path);
    let bytes;
    try {
      bytes = await readFile(cached);
    } catch {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error(
          `DuckDB extension download failed (${response.status}): ${url}`,
        );
      bytes = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, bytes);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const expected = lock.assets.find((asset) => asset.path === path);
    if (
      !record &&
      (!expected || expected.sha256 !== hash || expected.bytes !== bytes.length)
    )
      throw Error(`DuckDB extension integrity failed: ${path}`);
    assets.push({ path, url, bytes: bytes.length, sha256: hash });
    const target = resolve(root, "demo/dist-showcase/duckdb/extensions", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
if (record)
  await writeFile(
    lockPath,
    `${JSON.stringify({ ...lock, assets }, null, 2)}\n`,
  );
const output = resolve(root, "demo/dist-showcase/duckdb");
await copyFile(
  resolve(root, "demo/runtime-licenses/DuckDB-LICENSE.txt"),
  resolve(output, "LICENSE"),
);
await copyFile(
  resolve(root, "demo/runtime-licenses/ICU-LICENSE.txt"),
  resolve(output, "ICU-LICENSE.txt"),
);
await writeFile(
  resolve(output, "NOTICE.txt"),
  "DuckDB-Wasm and extension binaries are distributed from the official DuckDB project.\nDuckDB is MIT licensed: https://github.com/duckdb/duckdb/blob/v1.4.3/LICENSE\nICU incorporates Unicode/ICU data and its upstream license: https://github.com/unicode-org/icu/blob/main/LICENSE\nParquet incorporates Apache-licensed components: https://github.com/duckdb/duckdb/tree/v1.4.3/third_party\nRuntime source URLs and SHA-256 digests are pinned in demo/duckdb-runtime.json.\n",
);
console.log(
  `Bundled ${assets.length} verified DuckDB ${lock.engineVersion} extensions.`,
);
