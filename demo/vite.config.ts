import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Published packages resolve to dist/. The demo aliases workspace source so
// edits still hot-reload without rebuilding package tarballs.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@pythia-software/query-table-ui/theme.css", replacement: new URL("../packages/ui/src/theme.css", import.meta.url).pathname },
      { find: /^@pythia-software\/query-table-core$/, replacement: new URL("../packages/core/src/index.ts", import.meta.url).pathname },
      { find: /^@pythia-software\/query-table-react$/, replacement: new URL("../packages/react/src/index.ts", import.meta.url).pathname },
      { find: /^@pythia-software\/query-table-ui$/, replacement: new URL("../packages/ui/src/index.ts", import.meta.url).pathname },
    ],
  },
  server: { port: 5179 },
});
