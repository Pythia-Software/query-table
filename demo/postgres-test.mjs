import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// Integration test against the running demo; never seeds or modifies DB records.
const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const output = new URL("../.context/postgres-demo/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1080 },
  });
  const errors = [],
    metricResponses = [],
    metricQueries = [];
  let rowQuery,
    metricQuery,
    metadataRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/rows")) rowQuery = request.postDataJSON();
    if (request.url().endsWith("/metrics")) {
      metricQuery = request.postDataJSON();
      metricQueries.push(metricQuery);
    }
    if (request.url().endsWith("/distinct")) metadataRequests++;
  });
  page.on("response", (response) => {
    if (
      response.url().endsWith("/metrics") &&
      response.request().method() === "POST"
    )
      metricResponses.push(response);
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      "query-table:postgres-demo:latency",
      JSON.stringify({ db: 0, response: 0 }),
    ),
  );
  await page.goto(`${origin}/postgres`);
  await page.waitForFunction(
    () => document.querySelectorAll(".qt-metrics > .qt-metric").length === 20,
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(".qt-demo-live-status")
        ?.textContent.includes("No requests in flight") &&
      document
        .querySelector(".qt-demo-live-status")
        ?.textContent.includes("Dashboard idle"),
    null,
    { timeout: 180000 },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    await page
      .locator(".qt-metric-error, .qt-metrics-error, [role=alert]")
      .allTextContents(),
    [],
  );
  assert.ok(
    metadataRequests < 10,
    `metadata refetch loop: ${metadataRequests}`,
  );
  const bootstrap = await (
    await fetch(`${origin}/api/postgres/bootstrap`)
  ).json();
  assert.ok(bootstrap.rows >= 1000);
  assert.equal(
    metricResponses.length,
    4,
    "exactly four shards, with no table-triggered restart",
  );
  const batches = await Promise.all(
    metricResponses.map((response) => response.json()),
  );
  const initial = {
    metrics: batches.flatMap((batch) => batch.metrics),
    debug: { metrics: batches.flatMap((batch) => batch.debug.metrics) },
  };
  metricQuery = {
    ...metricQuery,
    metrics: metricQueries.flatMap((query) => query.metrics),
  };
  assert.equal(initial.metrics.length, 20);
  assert.equal(initial.debug.metrics.length, 20);
  assert.ok(
    initial.debug.metrics.every(
      (metric) => metric.sqlMs >= 0 && metric.stages > 0,
    ),
  );
  const byId = (id) => initial.metrics.find((metric) => metric.id === id);
  assert.equal(byId("pg-runs").buckets[0].value, bootstrap.rows);
  assert.equal(byId("pg-page").buckets[0].value, 100);
  assert.equal(byId("pg-pivot").buckets[0].keys.length, 2);
  assert.equal(byId("pg-flat").buckets[0].keys.length, 3);
  assert.ok(
    byId("pg-scatter").buckets.every((bucket) => typeof bucket.y === "number"),
  );
  for (const id of ["pg-box", "pg-queue-box", "pg-histogram"])
    assert.ok(byId(id).buckets.every((bucket) => bucket.distribution));
  await page.screenshot({ path: `${output}dashboard.png`, fullPage: true });
  console.log(
    `Dashboard: ${bootstrap.rows} actual rows, 20 metrics, distributions, ${metadataRequests} metadata requests; SQL ${metricResponses.at(-1).headers()["x-demo-sql-ms"]} ms`,
  );

  async function post(path, body, headers = {}) {
    const response = await fetch(`${origin}/api/postgres/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return { data, response };
  }
  const fraction = await post("rows", {
    ...rowQuery,
    select: ["id"],
    where: [{ field: "id", op: "<", value: "1.5" }],
    orderBy: [{ field: "id", dir: "asc" }],
    limit: 10,
    offset: 0,
  });
  assert.equal(fraction.data.total, 1);
  assert.equal(fraction.data.rows[0].id, 1);
  const filtered = await post("metrics", {
    ...metricQuery,
    where: [{ field: "id", op: "<", value: "1.5" }],
    metrics: [metricQuery.metrics.find((metric) => metric.id === "pg-runs")],
  });
  assert.equal(filtered.data.metrics[0].buckets[0].value, 1);

  const sortedQuery = {
    ...rowQuery,
    select: ["id", "@computed/throughput"],
    orderBy: [
      { field: "@computed/throughput", dir: "desc", nulls: "last" },
      { field: "id", dir: "asc" },
    ],
    where: [],
    limit: 25,
    offset: 0,
  };
  const first = await post("rows", sortedQuery);
  const next = await post("rows", { ...sortedQuery, offset: 25 });
  const sidecars = [...first.data.computed, ...next.data.computed];
  const values = sidecars.map((row) => row.values.throughput.value);
  assert.ok(
    values.every(
      (value, index) =>
        typeof value === "number" && (!index || value <= values[index - 1]),
    ),
  );
  assert.equal(new Set(sidecars.map((row) => row.id)).size, 50);
  assert.equal(first.data.total, bootstrap.rows);
  console.log(
    "Global computed sorting and pagination: 50 ordered, distinct results across two pages",
  );

  const quick = {
    ...rowQuery,
    select: ["id"],
    where: [{ field: "id", op: "<", value: "1.5" }],
    orderBy: [],
    limit: 1,
    offset: 0,
  };
  const start = Date.now();
  const delayed = await post("rows", quick, {
    "X-Demo-DB-Delay": "250",
    "X-Demo-Response-Delay": "350",
  });
  assert.ok(Date.now() - start >= 600);
  assert.equal(delayed.response.headers.get("x-demo-db-delay-ms"), "250");
  assert.equal(delayed.response.headers.get("x-demo-response-delay-ms"), "350");
  const before = await (await fetch(`${origin}/api/postgres/bootstrap`)).json();
  const controller = new AbortController();
  const canceled = fetch(`${origin}/api/postgres/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-DB-Delay": "5000" },
    body: JSON.stringify(quick),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(canceled, (error) => error.name === "AbortError");
  for (let i = 0; i < 30; i++) {
    const after = await (
      await fetch(`${origin}/api/postgres/bootstrap`)
    ).json();
    if (after.canceled > before.canceled) break;
    if (i === 29) assert.fail("Vite did not propagate cancellation to Go");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const mismatch = await fetch(`${origin}/api/postgres/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...quick, snapshot: "expired" }),
  });
  assert.equal(mismatch.status, 422);
  console.log(
    "Fractional filters, both delay stages, proxy cancellation, and snapshot rejection passed",
  );

  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
        ?.disabled,
    null,
    { timeout: 120000 },
  );
  await page
    .getByLabel("Metric name", { exact: true })
    .fill("PostgreSQL count");
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();
  await page.waitForTimeout(750);
  await page.reload();
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.getByLabel("Metric name", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Metric name", { exact: true }).inputValue(),
    "PostgreSQL count",
  );
  assert.deepEqual(errors, []);
  console.log("Metric editor and persisted dashboard passed");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Request activity", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Request activity", exact: true })
    .waitFor();
  assert.ok((await page.locator(".qt-request-activity tbody tr").count()) > 0);
  assert.equal(await page.locator(".qt-metric-data").count(), 0);
  await page
    .getByRole("button", { name: "Edit dashboard layout", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Workbench view").inputValue(),
    "dashboard",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const scatterCard = page
    .locator(".qt-metrics > .qt-metric")
    .filter({ hasText: "Worker volume × duration" });
  await scatterCard.hover();
  assert.equal(
    await scatterCard
      .locator(".qt-metric-edit")
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  await scatterCard.locator(".qt-metric-edit").click();
  assert.equal(
    await page.getByLabel("Metric name", { exact: true }).inputValue(),
    "Worker volume × duration",
  );
  await page
    .getByRole("dialog")
    .locator("summary")
    .filter({ hasText: /^Display/ })
    .click();
  await page
    .getByRole("dialog")
    .locator("summary")
    .filter({ hasText: "Scale & bounds" })
    .click();
  await page.getByLabel("X axis scale", { exact: true }).selectOption("log");
  await page.getByLabel("Y axis scale", { exact: true }).selectOption("log");
  await page.getByLabel("X axis min", { exact: true }).fill("0");
  await page.waitForFunction(() =>
    document
      .querySelector("[role=dialog]")
      ?.textContent.includes("Axis bounds must be finite"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Apply metrics", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("X axis min", { exact: true }).fill("1000");
  await page.getByLabel("X axis max", { exact: true }).fill("100000");
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click({ timeout: 120000 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForTimeout(750);
  await page.reload();
  await scatterCard.hover();
  await scatterCard.locator(".qt-metric-edit").click();
  await page
    .getByRole("dialog")
    .locator("summary")
    .filter({ hasText: /^Display/ })
    .click();
  assert.equal(
    await page.getByLabel("X axis scale", { exact: true }).inputValue(),
    "log",
  );
  assert.equal(
    await page.getByLabel("X axis min", { exact: true }).inputValue(),
    "1000",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    "Request activity, quick editing, scale validation and persistence passed",
  );
} finally {
  await browser.close();
}
