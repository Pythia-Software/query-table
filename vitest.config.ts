import { defineConfig } from "vitest/config";

// Test against source (not built dist) for fast iteration. No package build is
// needed before `npm test`; tsconfig.source-paths.json does the same for tsc.
const source = (name: string) => ({
  find: new RegExp(`^@pythia-software/query-table-${name}$`),
  replacement: new URL(`./packages/${name}/src/index.ts`, import.meta.url)
    .pathname,
});

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "tools/**/test/**/*.test.ts",
      "demo/test/**/*.test.ts",
    ],
  },
  resolve: {
    alias: [source("core"), source("react"), source("ui"), source("duckdb")],
  },
});
