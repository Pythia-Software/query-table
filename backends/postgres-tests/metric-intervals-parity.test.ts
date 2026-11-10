import { it } from "vitest";
import { checkMetricFixtureThroughGo } from "../sqlite-tests/metricFixtureHarness";

// Skips without QT_TEST_POSTGRES, like the Go suite it drives.
it.skipIf(!process.env.QT_TEST_POSTGRES)("runs the metric interval and Other fixture, planned on the client, with the real PostgreSQL executor", () => {
  checkMetricFixtureThroughGo(new URL("./", import.meta.url), "qt-postgres-v1");
}, 300000);
