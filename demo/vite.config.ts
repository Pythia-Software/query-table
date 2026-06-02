import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The @query-table/* packages ship raw TS source (their package.json `main`
// points at ./src/index.ts), so Vite compiles them straight from the workspace.
// No build step needed — edit a package and the demo hot-reloads.
export default defineConfig({
  plugins: [react()],
  server: { port: 5179 },
});
