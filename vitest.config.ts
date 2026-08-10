import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "tools/**/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Test against source (not built dist) for fast iteration.
      "@pythia-software/query-table-core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
});
