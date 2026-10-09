import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Published packages resolve to dist/. The demo aliases workspace source so
// edits still hot-reload without rebuilding package tarballs.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
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
});
