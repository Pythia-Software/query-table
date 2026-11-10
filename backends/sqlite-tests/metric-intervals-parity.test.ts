import { it } from "vitest";
import { checkMetricFixtureThroughGo } from "./metricFixtureHarness";

it("runs the metric interval and Other fixture, planned on the client, with the real SQLite executor", () => {
  checkMetricFixtureThroughGo(new URL("./", import.meta.url), "qt-sqlite-v1");
}, 300000);
