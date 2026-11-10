import { mergeConfig } from "vitest/config";
import base from "../../vitest.config";

// mergeConfig concatenates arrays, so set include after merging: this suite
// runs only its own parity tests, not the whole TypeScript suite again.
const config = mergeConfig(base, {});
config.test!.include = ["backends/postgres-tests/*parity.test.ts"];
export default config;
