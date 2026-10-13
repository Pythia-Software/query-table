import { decodeQuery } from "@pythia-software/query-table-core";
// Run against the local /grouping demo. Uses isolated browser storage.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = new URL(
  "/grouping",
  process.env.QT_DEMO_URL ?? "http://localhost:5179",
).toString();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.QT_BROWSER_PATH
    ? { executablePath: process.env.QT_BROWSER_PATH }
    : {}),
  ...(process.env.QT_BROWSER_CHANNEL
    ? { channel: process.env.QT_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() =>
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        window.__shared = text;
      },
    },
  }),
);
const button = (name) => page.getByRole("button", { name, exact: true });
const chooseView = (name) =>
  page
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name, exact: true })
    .click();
const pick = (name) =>
  page
    .locator(".qt-picker-item")
    .filter({
      has: page.locator(".qt-picker-label", {
        hasText: new RegExp(`^${name}$`),
      }),
    })
    .click();
const snapshot = async () => {
  await page.evaluate(() => { delete window.__shared; });
  await button("Share").click();
  await page.waitForFunction(() => typeof window.__shared === "string");
  const query = decodeQuery(new URL(await page.evaluate(() => window.__shared)).searchParams.get("q"));
  const { grouping, ...result } = query;
  return { version: 2, mode: grouping ? "groups" : "rows", keys: grouping?.keys ?? [], summaries: grouping?.summaries ?? [], representative: grouping?.representative ?? null, input: grouping?.source ?? result, result };
};
const shareUrl = (view) => {
  const next = new URL(url);
  next.searchParams.set("view", JSON.stringify(view));
  return next.toString();
};
const waitRows = (n) =>
  page.waitForFunction(
    (n) => document.querySelectorAll(".qt-table tbody tr").length === n,
    n,
  );
const rowValues = async (field) =>
  page.locator(`.qt-table tbody [data-qt-field="${field}"]`).allTextContents();
const openJobRow = async () => {
  await button("Add column").click();
  await pick("Job");
  await pick("Representative row");
};
try {
  await page.goto(url);
  await waitRows(25);
  assert.equal(await button("Add representative row").count(), 0);
  await chooseView("Busy workers");
  await waitRows(3);
  const original = await snapshot();
  assert.equal(original.version, 2);
  assert.equal(original.summaries.filter((s) => s.op === "row").length, 2);
  assert.equal(await button("Edit representative row").count(), 1);
  assert.equal(await button("Add representative row").count(), 0);
  const rowChips = page.locator('.qt-qb-row--select .qt-column-label[data-column-role="row"]');
  assert.equal(await rowChips.locator("select").count(), 0);
  assert.equal(await rowChips.locator(".qt-column-role-badge").count(), 2);
  await button("Add column").click();
  await pick("Job");
  assert.equal(await page.locator('.qt-picker-label').filter({ hasText: /^Representative row$/ }).count(), 0);
  await button("Close field picker").click();
  const aggregateBefore = await rowValues("avg_duration");
  assert.ok(aggregateBefore.length, "The aggregate cells are inspected");

  await button("Edit representative row").click();
  await button("Change representative field Duration").click();
  await pick("Enqueued");
  await button("Apply ordering").click();
  await page.waitForFunction(() =>
    document.querySelector(".qt-table tbody")?.textContent?.includes("#1025"),
  );
  assert.deepEqual(await rowValues("avg_duration"), aggregateBefore);
  assert.equal(await page.locator(".qt-metric-big-value").innerText(), "3");
  assert.deepEqual((await snapshot()).representative.orderBy, [
    { field: "enqueued_at", dir: "desc", nulls: "last" },
  ]);
  assert.equal(
    await page
      .locator('.qt-qb-row--select .qt-column-label[data-column-role="row"]')
      .count(),
    2,
  );
  // Discarding edits does not change the shared rule or the selected records.
  await button("Edit representative row").click();
  await page
    .getByLabel("Representative direction for Enqueued", { exact: true })
    .click();
  await button("Cancel").click();
  assert.equal((await snapshot()).representative.orderBy[0].dir, "desc");

  // A second sort refines the same row selection; priority can be reordered.
  await button("Edit representative row").click();
  await page
    .locator(".qt-representative-editor")
    .getByRole("button", { name: "add sort", exact: true })
    .click();
  await pick("Run");
  await page
    .getByLabel("Representative direction for Run", { exact: true })
    .click();
  await button("Drag to reorder Run").press("ArrowUp");
  await button("Apply ordering").click();
  const reordered = await snapshot();
  assert.deepEqual(
    reordered.representative.orderBy.map((t) => t.field),
    ["id", "enqueued_at"],
  );
  await button("Undo").click();
  assert.equal((await snapshot()).representative.orderBy.length, 1);
  await button("Redo").click();
  assert.deepEqual((await snapshot()).representative, reordered.representative);

  assert.equal(await button("Hide grouping").count(), 0);
  await button("Edit representative row").waitFor();
  assert.match(
    await page.getByLabel("Grouping and HAVING").innerText(),
    /Run ↑/,
  );
  assert.equal(await button("Edit grouping").count(), 0);
  await button("Edit representative row").click();
  await button("Remove row & 2 columns").click();
  assert.equal(
    await page.locator('.qt-th-label [data-column-role="row"]').count(),
    0,
  );
  assert.equal((await snapshot()).representative, null);
  assert.deepEqual(await rowValues("avg_duration"), aggregateBefore);
  await button("Undo").click();
  assert.equal(
    await page.locator('.qt-th-label [data-column-role="row"]').count(),
    2,
  );

  // Save/restore/share the exact common ordering with the output definitions.
  await button("Save query").click();
  await page.locator(".qt-qb-saved-input").fill("Representative by ID");
  await page.locator(".qt-qb-saved-input").press("Enter");
  await chooseView("Individual runs");
  await chooseView("Representative by ID");
  assert.deepEqual((await snapshot()).representative, reordered.representative);
  const fresh = await browser.newPage();
  await fresh.goto(shareUrl(await snapshot()));
  await fresh
    .getByRole("button", { name: "Edit representative row", exact: true })
    .waitFor();
  assert.match(
    await fresh.getByLabel("Grouping and HAVING").innerText(),
    /Run ↑/,
  );
  await fresh.close();
  await page.reload();
  await chooseView("Representative by ID");
  assert.deepEqual((await snapshot()).representative, reordered.representative);

  // Representative values are offered only after GROUP BY configures the shared row.
  await chooseView("Duration by platform");
  await button("Add column").click();
  await pick("Job");
  assert.equal(
    await page
      .locator(".qt-picker-label")
      .filter({ hasText: /^Representative row$/ })
      .count(),
    0,
  );
  await button("Close field picker").click();
  assert.equal(
    await page
      .getByLabel("Aggregation for Average Duration")
      .locator('option[value="row"]')
      .count(),
    0,
  );
  await button("Customize columns").click();
  const editor = page.getByRole("dialog", {
    name: "Select columns",
    exact: true,
  });
  await editor
    .getByRole("button", {
      name: "Average Duration Duration · AVG",
      exact: true,
    })
    .click();
  assert.equal(
    await editor.getByRole("button", { name: /Representative row/ }).count(),
    0,
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await button("Add representative row").click();
  assert.match(await page.locator(".qt-picker-description").innerText(), /first row.*every ROW column/);
  await pick("Duration");
  await button("Representative direction for Duration").click();
  await button("Apply ordering").click();
  await openJobRow();
  let current = await snapshot();
  assert.equal(current.representative.orderBy[0].dir, "asc");
  assert.equal(current.summaries.filter((s) => s.op === "row").length, 1);
  await button("Add column").click();
  await pick("Run");
  await pick("Representative row");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    (await snapshot()).summaries.filter((s) => s.op === "row").length,
    2,
  );
  await button("Customize columns").click();
  await editor
    .getByRole("button", {
      name: "Average Duration Duration · AVG",
      exact: true,
    })
    .click();
  await editor.getByRole("button", { name: /Representative row.*ROW/ }).click();
  assert.equal(
    await editor
      .getByRole("button", { name: "Edit representative row", exact: true })
      .count(),
    0,
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await button("Discard changes").click();
  assert.equal(
    (await snapshot()).summaries.find((s) => s.id === "avg_duration").op,
    "avg",
  );

  // Dependent HAVING / sort / metrics clear; unrelated aggregates retain meaning.
  const withDependencies = structuredClone(original);
  withDependencies.result.where.push({
    field: "example_id",
    op: ">",
    value: "1000",
  });
  withDependencies.result.orderBy = [{ field: "example_id", dir: "asc" }];
  withDependencies.result.aggregations.push({
    id: "from-row",
    op: "max",
    field: "example_id",
    groupBy: [],
  });
  await page.goto(shareUrl(withDependencies));
  await button("Edit representative row").click();
  await page
    .getByLabel("Representative direction for Duration", { exact: true })
    .click();
  await page
    .getByText(
      /Applying clears row-value filters, row-value sorts, dependent metrics/,
    )
    .waitFor();
  await button("Apply ordering").click();
  current = await snapshot();
  assert.deepEqual(current.result.where, original.result.where);
  assert.equal(current.result.orderBy.length, 0);
  assert.equal(current.result.aggregations.length, 1);
  await button("Undo").click();
  assert.equal((await snapshot()).result.aggregations.length, 2);

  // Narrow touch layout supports the same setup and explicit direction/nulls.
  await page.goto(url);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseView("Duration by platform");
  await button("Add representative row").click();
  await pick("Duration");
  await page
    .getByLabel("Representative direction for Duration", { exact: true })
    .click();
  await page
    .getByLabel("Representative empty values for Duration", { exact: true })
    .click();
  await page
    .locator(".qt-representative-editor")
    .getByRole("button", { name: "add sort", exact: true })
    .click();
  await pick("Enqueued");
  await page.screenshot({
    path: ".context/representative-mobile-editor.png",
    fullPage: true,
  });
  await button("Apply ordering").click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  current = await snapshot();
  assert.equal(current.representative.orderBy[0].nulls, "first");
  assert.equal(current.representative.orderBy.length, 2);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );

  // Mobile column selection also reuses the strategy, without offering its editor.
  await openJobRow();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    (await snapshot()).summaries.filter((s) => s.op === "row").length,
    1,
  );

  // Existing single-rule views migrate, and mixed-rule data is retained intact.
  const legacy = { ...original, version: 1 };
  delete legacy.representative;
  legacy.summaries = original.summaries.map((s) =>
    s.op === "row" ? { ...s, op: "longest" } : s,
  );
  const mixed = structuredClone(legacy);
  mixed.summaries.find((s) => s.id === "example_job").op = "latest";
  const legacyStorage = JSON.stringify({
    items: [
      {
        id: "old",
        name: "Old longest view",
        savedAt: 1,
        view: legacy,
        query: legacy.result,
      },
      {
        id: "mixed",
        name: "Mixed rules",
        savedAt: 1,
        view: mixed,
        query: mixed.result,
      },
    ],
    defaultId: "old",
  });
  const migration = await browser.newPage();
  migration.on("pageerror", (error) => errors.push(error.message));
  await migration.addInitScript(
    (stored) =>
      localStorage.setItem("query-table:grouping-prototype:v1", stored),
    legacyStorage,
  );
  await migration.goto(url);
  await migration
    .getByRole("button", { name: "Edit representative row", exact: true })
    .waitFor();
  assert.match(
    await migration.getByLabel("Grouping and HAVING").innerText(),
    /Duration ↓/,
  );
  assert.match(
    await migration.locator(".qt-group-notice").innerText(),
    /Mixed rules.*both latest and longest/,
  );
  assert.equal(
    await migration.evaluate(() =>
      localStorage.getItem("query-table:grouping-prototype:v1"),
    ),
    legacyStorage,
  );
  assert.equal(
    await migration.evaluate(() =>
      localStorage.getItem(
        "query-table:grouping-prototype:v2:unreadable-backup",
      ),
    ),
    legacyStorage,
  );
  await migration
    .getByRole("button", { name: "Add column", exact: true })
    .click();
  await migration
    .locator(".qt-picker-item")
    .filter({
      has: migration.locator(".qt-picker-label", { hasText: /^Duration$/ }),
    })
    .click();
  await migration
    .locator(".qt-picker-item")
    .filter({
      has: migration.locator(".qt-picker-label", { hasText: /^Total$/ }),
    })
    .click();
  await migration
    .getByRole("button", { name: "Save query", exact: true })
    .click();
  await migration.locator(".qt-qb-saved-input").fill("Migrated view");
  await migration.locator(".qt-qb-saved-input").press("Enter");
  await migration
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name: "Migrated view", exact: true })
    .waitFor();
  assert.equal(
    await migration.evaluate(() =>
      localStorage.getItem("query-table:grouping-prototype:v1"),
    ),
    legacyStorage,
  );
  const v2 = await migration.evaluate(() =>
    JSON.parse(localStorage.getItem("query-table:saved:grouping-library-input")),
  );
  assert.ok(v2.every((item) => item.query.grouping && !item.view));
  await migration.close();
  assert.deepEqual(errors, []);
  console.log(
    "Representative browser checks passed: shared ordering, priorities, cancellation, invalidation, undo/redo, saved views, GROUP BY setup, column drafts, and mobile.",
  );
} catch (error) {
  await page.screenshot({
    path: ".context/representative-failure.png",
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
