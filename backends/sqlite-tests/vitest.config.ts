import { mergeConfig } from "vitest/config";
import base from "../../vitest.config";
export default mergeConfig(base, {
  test: { include: ["backends/sqlite-tests/*parity.test.ts"] },
});
