import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Published packages resolve to dist/. The demo aliases workspace source so
// edits still hot-reload without rebuilding package tarballs.
export default defineConfig(({ mode }) => ({
  base: mode === "showcase" ? "./" : "/",
  plugins: [
    react(),
    ...(mode === "showcase"
      ? [
          {
            name: "showcase-static-assets",
            async closeBundle() {
              const output = resolve(import.meta.dirname, "dist-showcase");
              await mkdir(resolve(output, "duckdb"), { recursive: true });
              for (const file of [
                "duckdb-mvp.wasm",
                "duckdb-browser-mvp.worker.js",
                "duckdb-eh.wasm",
                "duckdb-browser-eh.worker.js",
              ]) {
                await copyFile(
                  require.resolve(`@duckdb/duckdb-wasm/dist/${file}`),
                  resolve(output, "duckdb", file),
                );
              }
              await copyFile(
                resolve(
                  import.meta.dirname,
                  "../assets/brand/query-table-icon.svg",
                ),
                resolve(output, "favicon.svg"),
              );
              await rename(
                resolve(output, "showcase.html"),
                resolve(output, "index.html"),
              );
              await writeFile(resolve(output, ".nojekyll"), "");
            },
          },
        ]
      : []),
  ],
  build:
    mode === "showcase"
      ? {
          outDir: "dist-showcase",
          rollupOptions: {
            input: resolve(import.meta.dirname, "showcase.html"),
          },
        }
      : {},
  resolve: {
    alias: [
      {
        find: /^@pythia-software\/query-table-duckdb$/,
        replacement: new URL("../packages/duckdb/src/index.ts", import.meta.url)
          .pathname,
      },
      {
        find: "@pythia-software/query-table-ui/theme.css",
        replacement: new URL("../packages/ui/src/theme.css", import.meta.url)
          .pathname,
      },
      {
        find: /^@pythia-software\/query-table-core$/,
        replacement: new URL("../packages/core/src/index.ts", import.meta.url)
          .pathname,
      },
      {
        find: /^@pythia-software\/query-table-react$/,
        replacement: new URL("../packages/react/src/index.ts", import.meta.url)
          .pathname,
      },
      {
        find: /^@pythia-software\/query-table-ui$/,
        replacement: new URL("../packages/ui/src/index.ts", import.meta.url)
          .pathname,
      },
    ],
  },
  server: {
    port: 5179,
    proxy: {
      "/api/postgres": {
        target: "http://127.0.0.1:5180",
        configure(proxy) {
          // Propagate browser cancellation through Vite to Go/QueryContext.
          proxy.on("proxyReq", (upstream, _request, response) => {
            response.on("close", () => {
              if (!response.writableEnded) upstream.destroy();
            });
          });
        },
      },
    },
  },
}));
