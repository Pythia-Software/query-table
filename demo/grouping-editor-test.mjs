// Integration coverage for aggregate formulas and the shared editor panels.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.QT_BROWSER_PATH
    ? { executablePath: process.env.QT_BROWSER_PATH }
    : {}),
  ...(process.env.QT_BROWSER_CHANNEL
    ? { channel: process.env.QT_BROWSER_CHANNEL }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        window.__shared = value;
      },
    },
  });
});
const button = (name) => page.getByRole("button", { name, exact: true });
const view = (name) =>
  page
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name, exact: true })
    .click();
const editor = page.getByRole("dialog", {
  name: "Select columns",
  exact: true,
});
const formula = page.getByLabel("Aggregate column formula", { exact: true });
const pick = (label) =>
  page
    .locator(".qt-picker-item")
    .filter({
      has: page.locator(".qt-picker-label", {
        hasText: new RegExp(`^${label}$`),
      }),
    })
    .click();
const screenshot = (name) =>
  page.screenshot({
    path: new URL(`../.context/${name}.png`, import.meta.url).pathname,
    fullPage: true,
  });
const previewValues = () =>
  page.locator(".qt-columns-preview tbody td.is-focused").allTextContents();
const waitForValid = () =>
  page.waitForFunction(() => {
    const apply = [...document.querySelectorAll("button")].find(
      (el) => el.textContent === "Apply columns",
    );
    return apply && !apply.disabled;
  });
const discard = async () => {
  await button("Cancel").click();
  await button("Discard changes").click();
};
await mkdir(new URL("../.context/", import.meta.url), { recursive: true });
try {
  await page.goto(new URL("/grouping", origin).toString());
  await page.locator(".qt-table tbody tr").first().waitFor();
  const addStyle = (element) =>
    element.evaluate((el) => {
      const border = getComputedStyle(el.closest(".qt-split-btn") ?? el);
      return {
        color: getComputedStyle(el).color,
        border: border.borderTopStyle,
      };
    });
  const addColumnStyle = await addStyle(button("Add column"));
  for (const label of ["Add offset", "Add filter", "Add group by"])
    assert.deepEqual(await addStyle(button(label)), addColumnStyle);
  await button("Add group by").click();
  await pick("Platform");
  assert.deepEqual(await addStyle(button("Add metric")), addColumnStyle);
  assert.match(await button("Add metric").innerText(), /add metric/);
  assert.equal(
    await button("Add metric").locator('[data-icon="arrowRight"]').count(),
    1,
  );
  await page.getByLabel("limit", { exact: true }).fill("5");
  await page.getByLabel("limit", { exact: true }).press("Enter");
  assert.equal(
    await page.getByTitle("Reset limit and offset", { exact: true }).count(),
    0,
  );
  await screenshot("grouping-optional-clauses");
  await view("Individual runs");
  assert.equal(await page.locator("[data-column-role]").count(), 0);
  await button("Customize columns").click();
  assert.equal(await editor.locator("[data-column-role]").count(), 0);
  const columnPanels = page.getByRole("group", {
    name: "Visible column panels",
  });
  assert.equal(
    await columnPanels.evaluate((el) => !!el.closest("header")),
    true,
  );
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), false);
  const workspace = page.locator(".qt-columns-workspace");
  const geometry = () =>
    workspace.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  const original = await geometry();
  const separator = page.getByRole("separator", {
    name: "Resize column panels 1 and 2",
  });
  const width = Number(await separator.getAttribute("aria-valuenow"));
  await separator.press("ArrowRight");
  assert.equal(
    Number(await separator.getAttribute("aria-valuenow")),
    width + 10,
  );
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 60);
  await page.mouse.down();
  await page.mouse.move(handle.x + 62, handle.y + 60, { steps: 5 });
  await page.mouse.up();
  assert.ok(Number(await separator.getAttribute("aria-valuenow")) > width + 50);
  await button("Hide columns panel").click();
  assert.equal(await page.locator(".qt-columns-library").isVisible(), false);
  await button("Hide column panel").click();
  assert.equal(await button("Hide preview panel").isDisabled(), true);
  assert.equal(await button("Preview panel").isDisabled(), true);
  // A desktop-hidden panel is still reachable through the phone section tabs.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".qt-columns-definition").waitFor({ state: "visible" });
  assert.equal(await page.locator(".qt-columns-definition").isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".qt-columns-definition").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".qt-columns-definition").isVisible(), false);
  await button("Columns panel").click();
  await page.locator(".qt-column-item-name").first().click();
  assert.equal(await page.locator(".qt-columns-definition").isVisible(), true);
  await button("Reset layout").click();
  assert.equal(await geometry(), original);
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), false);
  assert.equal(await editor.getByRole("separator").count(), 2);
  assert.equal(
    await editor.getByText("Unsaved changes", { exact: true }).count(),
    0,
  );
  await button("Close column editor").click();

  // Field-first custom aggregates share the row-formula editor and catalogue.
  await view("Duration by platform");
  await button("Add column").click();
  await pick("Duration");
  await pick("Custom aggregate…");
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), true);
  assert.equal(
    await page.locator(".qt-columns-definition .qt-function-library").count(),
    0,
  );
  assert.deepEqual(
    await button("Custom aggregate").evaluate((el) => ({
      height: el.offsetHeight,
      border: getComputedStyle(el).borderTopStyle,
    })),
    await button("Add column to view").evaluate((el) => ({
      height: el.offsetHeight,
      border: getComputedStyle(el).borderTopStyle,
    })),
  );
  assert.equal(await formula.inputValue(), "AVG([total_ms])");
  await page.getByLabel("Aggregate column name").fill("Median duration");
  await formula.fill("MED");
  await page
    .getByRole("listbox", { name: "Formula suggestions" })
    .getByRole("option", { name: /^MEDIAN/ })
    .click();
  assert.equal(await formula.inputValue(), "MEDIAN()");
  await formula.fill("MEDIAN([total_ms])");
  await page.getByLabel("Aggregate column name").click();
  await waitForValid();
  const expected = await previewValues();
  assert.equal(expected.length, 3);
  assert.ok(
    expected.every((value) => /^[\d,.]+$/.test(value)),
    expected.join(", "),
  );
  await page.getByLabel("Browse by concept").selectOption("aggregates");
  await page.getByRole("combobox", { name: "Search functions" }).fill("middle");
  await page
    .getByRole("option", { name: "Insert MEDIAN", exact: true })
    .waitFor();
  // The separate library inserts at the textarea selection, including when
  // its panel is hidden, and keeps native text undo.
  await formula.fill("[total_ms]");
  await formula.press("ControlOrMeta+a");
  await button("Column panel").click();
  await page
    .getByRole("option", { name: "Insert MEDIAN", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Aggregate column formula"]')
        ?.value === "MEDIAN([total_ms])",
  );
  assert.equal(await page.locator(".qt-columns-definition").isVisible(), true);
  await formula.press("ControlOrMeta+z");
  assert.equal(await formula.inputValue(), "[total_ms]");
  await formula.fill("MEDIAN([total_ms])");
  await button("Hide functions panel").click();
  await formula.fill("MEDIAN([total_ms]) + 0");
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), false);
  await button("Reset layout").click();
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), true);
  assert.equal(await formula.inputValue(), "MEDIAN([total_ms]) + 0");
  await page
    .locator(".qt-column-item-name")
    .filter({ hasText: "Average Duration" })
    .click();
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), false);
  await button("Functions panel").click();
  assert.equal(
    await page
      .getByRole("option", { name: "MEDIAN", exact: true })
      .isDisabled(),
    true,
  );
  await button("Reset layout").click();
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), false);
  await page
    .locator(".qt-column-item-name")
    .filter({ hasText: "Median duration" })
    .click();
  assert.equal(await page.locator(".qt-columns-functions").isVisible(), true);
  await formula.fill("MEDIAN([total_ms])");
  // A hidden definition keeps the unfinished formula and its scroll position.
  const definition = page.locator(".qt-columns-definition");
  const scroll = await definition.evaluate((el) => {
    el.scrollTop = 160;
    return el.scrollTop;
  });
  await button("Column panel").click();
  await button("Column panel").click();
  assert.equal(await formula.inputValue(), "MEDIAN([total_ms])");
  assert.equal(await definition.evaluate((el) => el.scrollTop), scroll);
  await definition.evaluate((el) => {
    el.scrollTop = 0;
  });
  await screenshot("grouping-aggregate-editor");
  await button("Apply columns").click();
  await page.getByRole("columnheader", { name: /Median duration/ }).waitFor();
  await page.waitForFunction(
    (expected) =>
      JSON.stringify(
        [...document.querySelectorAll(".qt-table tbody tr")].map(
          (row) => row.querySelectorAll("td")[4]?.textContent,
        ),
      ) === JSON.stringify(expected),
    expected,
  );
  const medianCells = await page
    .locator(".qt-table tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelectorAll("td")[4].textContent),
    );
  assert.deepEqual(medianCells, expected);
  await button("Undo").click();
  assert.equal(
    await page.getByRole("columnheader", { name: /Median duration/ }).count(),
    0,
  );
  await button("Redo").click();
  await page.getByRole("columnheader", { name: /Median duration/ }).waitFor();

  // Cancel and an invalid-column removal must not trap the draft or lose edits.
  await button("Customize columns").click();
  await page
    .locator(".qt-column-item-name")
    .filter({ hasText: "Median duration" })
    .click();
  await formula.fill("MAX([total_ms]) - MIN([total_ms])");
  await discard();
  await button("Customize columns").click();
  await page
    .locator(".qt-column-item-name")
    .filter({ hasText: "Median duration" })
    .click();
  assert.equal(await formula.inputValue(), "MEDIAN([total_ms])");
  await formula.fill("[total_ms]");
  assert.equal(await button("Apply columns").isDisabled(), true);
  await editor.getByText("Row fields must be inside an aggregate.").waitFor();
  await button("Remove Median duration").click();
  await waitForValid();
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await formula.inputValue(), "[total_ms]");
  assert.equal(await button("Apply columns").isDisabled(), true);
  await formula.fill("MEDIAN([total_ms])");
  await button("Custom aggregate").click();
  await formula.fill("MEDIAN(");
  assert.equal(await button("Apply columns").isDisabled(), true);
  await button("Remove Custom aggregate").click();
  await waitForValid();
  await button("Apply columns").click();

  // Named views and share links carry the expression and label together.
  await button("Save query").click();
  await page.locator(".qt-qb-saved-input").fill("Median by platform");
  await page.locator(".qt-qb-saved-input").press("Enter");
  await page
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name: "Median by platform", exact: true })
    .waitFor();
  await page.reload();
  await view("Median by platform");
  await page.getByRole("columnheader", { name: /Median duration/ }).waitFor();
  await button("Share").click();
  const shared = await page.evaluate(() => window.__shared);
  const fresh = await browser.newPage();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(shared);
  await fresh.getByRole("columnheader", { name: /Median duration/ }).waitFor();
  await fresh.waitForFunction(
    (expected) =>
      JSON.stringify(
        [...document.querySelectorAll(".qt-table tbody tr")].map(
          (row) => row.querySelectorAll("td")[4]?.textContent,
        ),
      ) === JSON.stringify(expected),
    expected,
  );
  assert.deepEqual(
    await fresh
      .locator(".qt-table tbody tr")
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelectorAll("td")[4].textContent),
      ),
    expected,
  );
  await fresh.close();
  await screenshot("grouping-aggregate-results");

  // Formula entry and preview remain usable at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await button("Customize columns").click();
  const sections = page.getByRole("navigation", {
    name: "Column editor sections",
  });
  await sections.getByRole("button", { name: /Columns/ }).click();
  await page
    .locator(".qt-column-item-name")
    .filter({ hasText: "Median duration" })
    .click();
  await formula.fill("[total_ms]");
  await formula.press("ControlOrMeta+a");
  await sections
    .getByRole("button", { name: "Functions", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Search functions" }).fill("median");
  await screenshot("grouping-functions-mobile");
  await page
    .getByRole("option", { name: "Insert MEDIAN", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Aggregate column formula"]')
        ?.value === "MEDIAN([total_ms])",
  );
  assert.equal(await formula.isVisible(), true);
  await formula.fill("ROUND(MEDIAN([total_ms]) / 1000, 2)");
  await page.getByLabel("Aggregate column name").fill("Median seconds");
  await sections.getByRole("button", { name: "Preview", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.ok((await previewValues()).every((value) => /^[\d,.]+$/.test(value)));
  await screenshot("grouping-aggregate-mobile");
  await button("Apply columns").click();
  await page.getByRole("columnheader", { name: /Median seconds/ }).waitFor();
  await view("Individual runs");
  assert.equal(await page.locator("[data-column-role]").count(), 0);

  // The metric editor uses the same panel components and preserves its draft.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL("/", origin).toString());
  await button("Edit metrics").click();
  const metricName = page.getByLabel("Metric name", { exact: true });
  const originalName = await metricName.inputValue();
  await metricName.fill("Panel preservation check");
  const metricPanels = page.getByRole("group", {
    name: "Visible editor panels",
  });
  assert.equal(
    await metricPanels.evaluate((el) => !!el.closest("header")),
    true,
  );
  await metricPanels
    .getByRole("button", { name: "Metric list panel", exact: true })
    .click();
  await metricPanels
    .getByRole("button", { name: "Fields & functions panel", exact: true })
    .click();
  const metricSeparator = page.getByRole("separator", {
    name: "Resize metric panes 2 and 4",
  });
  const beforeMetric = Number(
    await metricSeparator.getAttribute("aria-valuenow"),
  );
  await metricSeparator.press("ArrowRight");
  assert.equal(
    Number(await metricSeparator.getAttribute("aria-valuenow")),
    beforeMetric + 10,
  );
  await metricPanels
    .getByRole("button", { name: "Definition panel", exact: true })
    .click();
  assert.equal(
    await metricPanels
      .getByRole("button", { name: "Live preview panel", exact: true })
      .isDisabled(),
    true,
  );
  await button("Reset layout").click();
  assert.equal(await metricName.inputValue(), "Panel preservation check");
  await discard();
  await button("Edit metrics").click();
  assert.equal(await metricName.inputValue(), originalName);
  await button("Cancel").click();

  // Hidden computed columns remain directly selectable from both grouped
  // pickers, and retain their definition and evaluated values.
  await page.goto(new URL("/grouping", origin).toString());
  await view("Duration by platform");
  await button("Customize columns").click();
  await button("Computed columns…").click();
  const computedEditor = page.locator(".qt-select-editor");
  await computedEditor.getByRole("button", { name: "Computed column", exact: true }).click();
  await computedEditor.getByLabel("Column name", { exact: true }).fill("Twice runs");
  await computedEditor.getByLabel("Computed column formula", { exact: true }).fill("[run_count] * 2");
  await computedEditor.getByRole("button", { name: "Save definition & add column", exact: true }).click();
  await computedEditor.getByText("Definition saved.", { exact: false }).waitFor();
  await computedEditor.getByRole("button", { name: "Apply columns", exact: true }).click();
  await button("Apply columns").click();
  const computedValues = () => page.locator('td[data-qt-field^="@computed/"]').allTextContents();
  const waitForComputed = () => page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('td[data-qt-field^="@computed/"]')];
    return cells.length > 0 && cells.every(cell => /^\d+$/.test(cell.textContent));
  });
  await waitForComputed();
  const originalComputed = await computedValues();
  for (const fromEditor of [false, true]) {
    await button("Remove Twice runs column").click();
    if (fromEditor) await button("Customize columns").click();
    await button(fromEditor ? "Add column to view" : "Add column").click();
    await pick("Twice runs");
    if (fromEditor) await button("Apply columns").click();
    await waitForComputed();
    assert.deepEqual(await computedValues(), originalComputed);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Grouping editor checks passed: conditional roles, shared panel geometry, formula discovery, MEDIAN preview, invalid drafts/removal, undo/redo, saving/sharing, mobile, and metric-editor preservation.",
  );
} catch (error) {
  await screenshot("grouping-editor-failure");
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
