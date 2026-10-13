// Start the demo first. QT_DEMO_URL may be the origin or the /grouping URL.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text) => {
        window.__shared = text;
      },
    },
  });
});
const button = (name) => page.getByRole("button", { name, exact: true });
const waitRows = (count) =>
  page.waitForFunction(
    (count) => document.querySelectorAll(".qt-table tbody tr").length === count,
    count,
  );
const pick = (label) =>
  page
    .locator(".qt-picker-item")
    .filter({
      has: page.locator(".qt-picker-label", {
        hasText: new RegExp(`^${label}$`),
      }),
    })
    .click();
const metric = (value) =>
  page.waitForFunction(
    (value) =>
      document.querySelector(".qt-metric-big-value")?.textContent ===
      String(value),
    value,
  );
const chooseView = async (name) => {
  await page
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name, exact: true })
    .click();
};
const add = async (field, option) => {
  await button("Add column").click();
  await page
    .locator(".qt-picker-item")
    .filter({
      has: page.locator(".qt-picker-label", {
        hasText: new RegExp(`^${field}$`),
      }),
    })
    .click();
  if (option)
    await page
      .locator(".qt-picker-item")
      .filter({
        has: page.locator(".qt-picker-label", {
          hasText: new RegExp(`^${option}$`),
        }),
      })
      .click();
};
try {
  await page.goto(url);
  await waitRows(25);
  await metric(40);
  assert.equal(await page.locator("tbody tr").count(), 25);
  assert.equal(await page.getByLabel("Grouping and HAVING").count(), 0);
  await button("Add column").click();
  assert.equal(await page.locator('.qt-picker-label').filter({ hasText: /^Duration$/ }).count(), 0);
  await button("Close field picker").click();
  // Record columns use the same modal and keep selection edits transactional.
  await button("Customize columns").click();
  const rawEditor = page.getByRole("dialog", {
    name: "Select columns",
    exact: true,
  });
  await rawEditor.locator(".qt-column-preview-note").waitFor();
  const firstItem = rawEditor
    .locator(".qt-column-items .qt-column-item-name")
    .first();
  const removedLabel = await firstItem.locator("strong").innerText();
  await button("Add column to view").click();
  assert.equal(await page.locator('.qt-picker-label').filter({ hasText: removedLabel }).count(), 0);
  await button("Close field picker").click();
  const initialHeaders = await page.locator(".qt-table th").count();
  await rawEditor
    .getByRole("button", { name: `Remove ${removedLabel}`, exact: true })
    .click();
  await rawEditor
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  assert.equal(await page.locator(".qt-table th").count(), initialHeaders - 1);
  await button("Undo").click();
  assert.equal(await page.locator(".qt-table th").count(), initialHeaders);

  await button("Add group by").click();
  await button("Platform platform").click();
  await waitRows(3);
  assert.equal(
    await page.locator(".qt-metric-big-value").count(),
    0,
    "Record count is not reinterpreted as group count",
  );
  await add("Row count");
  await add("Duration", "Average");
  await add("Duration", "Largest");
  await page.getByRole("columnheader", { name: /Max Duration/ }).waitFor();
  // Selected field/operation pairs disappear, while other summaries remain.
  const assertAvailableChoices = async (addButton) => {
    await button(addButton).click();
    assert.equal(await page.getByText("Quick add", { exact: true }).count(), 0);
    assert.equal(await page.locator('.qt-picker-label').filter({ hasText: /^Row count$/ }).count(), 0);
    await pick("Duration");
    const choices = await page.locator('.qt-picker-label').allTextContents();
    assert.ok(!choices.includes("Average") && !choices.includes("Largest"));
    assert.ok(choices.includes("Total") && choices.includes("Smallest"));
    await button("Close field picker").click();
  };
  await assertAvailableChoices("Add column");
  await button("Customize columns").click();
  await assertAvailableChoices("Add column to view");
  await button("Close column editor").click();
  // Hiding a column makes the existing definition available to restore once.
  await button("Remove Row count column").click();
  await button("Add column").click();
  assert.equal(await page.locator('.qt-picker-label').filter({ hasText: /^Row count$/ }).count(), 1);
  await pick("Row count");
  assert.equal(
    await page.locator('select[aria-label^="Aggregation for"]').count(),
    3,
  );
  await page
    .getByLabel("Aggregation for Average Duration", { exact: true })
    .selectOption("sum");
  await page.getByRole("columnheader", { name: /Total Duration/ }).waitFor();
  await button("Undo").click();
  await page.getByRole("columnheader", { name: /Average Duration/ }).waitFor();
  await button("Redo").click();
  await page.getByRole("columnheader", { name: /Total Duration/ }).waitFor();

  // WHERE and HAVING act on different row schemas.
  await button("Add filter").click();
  await button("Platform platform").click();
  await page
    .getByLabel("Value for Platform", { exact: true })
    .selectOption("linux");
  await waitRows(1);
  await chooseView("Duration by platform");
  await waitRows(3);
  await metric(3);
  assert.equal(
    await page.locator('[data-clause="where"] [data-qt-filter]').count(),
    0,
    "A saved view restores its own source filters",
  );
  await button("Remove Platform column").click();
  await waitRows(25);
  await metric(40);
  await button("Undo").click();
  await metric(3);
  await page
    .getByLabel("Aggregation for Average Duration", { exact: true })
    .waitFor();

  await chooseView("Busy workers");
  await waitRows(3);
  await metric(3);
  await page.getByLabel("Value for Row count", { exact: true }).fill("11");
  await waitRows(1);
  await metric(1);
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.match(await page.locator("tbody").innerText(), /#1002/);

  // Draft edits update the preview, but cancel leaves the query unchanged.
  await chooseView("Duration by platform");
  await metric(3);
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
  await editor.getByRole("button", { name: "Total SUM", exact: true }).click();
  assert.match(
    await editor.locator(".qt-columns-preview").innerText(),
    /Total Duration/,
  );
  assert.equal(
    await page
      .locator(".qt-table")
      .getByRole("columnheader", { name: /Average Duration/ })
      .count(),
    1,
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await editor
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await metric(3);
  assert.equal(
    await page
      .locator(".qt-table")
      .getByRole("columnheader", { name: /Average Duration/ })
      .count(),
    1,
  );

  // Escape dismisses a nested picker without closing the parent workbench.
  await button("Customize columns").click();
  await editor
    .getByRole("button", { name: "Add column to view", exact: true })
    .click();
  await page.getByLabel("Search fields").press("Escape");
  assert.equal(await editor.count(), 1);
  assert.equal(await page.locator(".qt-picker-popover").count(), 0);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  // Applying a source/summary edit clears affected metrics; compound undo restores them.
  await button("Customize columns").click();
  await editor
    .getByRole("button", {
      name: "Average Duration Duration · AVG",
      exact: true,
    })
    .click();
  await editor.getByRole("button", { name: "Total SUM", exact: true }).click();
  await editor
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  await page.getByRole("columnheader", { name: /Total Duration/ }).waitFor();
  assert.equal(await page.locator(".qt-metric-big-value").count(), 0);
  assert.equal(await page.locator(".qt-qt-section--metrics").count(), 0);
  await button("Undo").click();
  await metric(3);

  // Add a second summary of the same field without starting the field search over.
  await button("Customize columns").click();
  await editor
    .getByRole("button", {
      name: "Average Duration Duration · AVG",
      exact: true,
    })
    .click();
  await editor
    .getByRole("button", { name: "Add another Duration column", exact: true })
    .click();
  await pick("Smallest");
  await editor
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  await page.getByRole("columnheader", { name: /Min Duration/ }).waitFor();
  await button("Undo").click();

  // Field-first picker stays attached to its trigger and retains search on Back.
  await button("Add column").click();
  await page.getByLabel("Search fields").fill("Dura");
  await pick("Duration");
  const popover = page.locator(".qt-picker-popover");
  const triggerRect = await button("Add column").boundingBox();
  const popoverRect = await popover.boundingBox();
  assert.ok(Math.abs(triggerRect.x - popoverRect.x) < 2);
  assert.ok(popoverRect.y >= triggerRect.y + triggerRect.height);
  await button("Back to fields").click();
  assert.equal(await page.getByLabel("Search fields").inputValue(), "Dura");
  await page.getByLabel("Search fields").press("Escape");
  assert.equal(
    await button("Add column").evaluate((el) => el === document.activeElement),
    true,
  );
  await button("Add column").click();
  await page.getByLabel("Search fields").fill("Dura");
  await page.getByLabel("Search fields").press("ArrowDown");
  await page.keyboard.press("Enter");
  await pick("Total");
  await page.getByRole("columnheader", { name: /Total Duration/ }).waitFor();

  // Optional offset is absent at zero and returns to its add action when cleared.
  assert.equal(await page.getByLabel("offset", { exact: true }).count(), 0);
  await button("Add offset").click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByLabel("offset", { exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByLabel("offset", { exact: true }).fill("1");
  await page.getByLabel("offset", { exact: true }).press("Enter");
  await waitRows(2);
  await button("Clear offset").click();
  await waitRows(3);
  assert.equal(await page.getByLabel("offset", { exact: true }).count(), 0);
  await chooseView("Busy workers");
  await page.getByLabel("Value for Row count", { exact: true }).fill("11");
  await metric(1);

  // Save and reload a complete definition, then share it into a fresh context.
  await button("Save query").click();
  await page.locator(".qt-qb-saved-input").fill("Eleven runs per worker");
  await page.locator(".qt-qb-saved-input").press("Enter");
  await page
    .getByRole("navigation", { name: "Saved views" })
    .getByRole("button", { name: "Eleven runs per worker", exact: true })
    .waitFor();
  await chooseView("Individual runs");
  await chooseView("Eleven runs per worker");
  await waitRows(1);
  await button("Share").click();
  const shared = await page.evaluate(() => window.__shared);
  assert.ok(new URL(shared).searchParams.get("q"));
  const fresh = await browser.newPage();
  fresh.on("pageerror", (error) => errors.push(error.message));
  await fresh.goto(shared);
  await fresh.waitForFunction(
    () => document.querySelectorAll(".qt-table tbody tr").length === 1,
  );
  await fresh.close();

  // The saved picker also works while the query editor is collapsed.
  assert.equal(await button("Hide grouping").count(), 0);
  assert.equal(await button("individual rows").count(), 0);
  assert.equal(await page.getByLabel("Value for Row count", { exact: true }).count(), 1);
  await button("Collapse query builder").click();
  await button("Saved (4)").click();
  const item = page
    .locator(".qt-saved-item")
    .filter({ hasText: "Eleven runs per worker" });
  await item.getByRole("button", { name: "make default", exact: true }).click();
  await page.reload();
  await waitRows(1);
  await metric(1);
  await chooseView("Duration by platform");
  await waitRows(3);
  await button("Customize columns").click();
  await page
    .getByRole("dialog", { name: "Select columns", exact: true })
    .waitFor();
  await button("Remove Max Duration").click();
  await button("Apply columns").click();
  assert.equal(
    await page.getByRole("columnheader", { name: /Max Duration/ }).count(),
    0,
  );
  await button("Reset").click();
  await page.getByRole("columnheader", { name: /Max Duration/ }).waitFor();
  await mkdir(new URL("../.context/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: new URL("../.context/grouping-desktop.png", import.meta.url).pathname,
    fullPage: true,
  });

  // Keep the same builder controls at a narrow touch-sized viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseView("Busy workers");
  await waitRows(3);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await add("Duration", "Total");
  await page
    .getByLabel("Aggregation for Total Duration", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.screenshot({
    path: new URL("../.context/grouping-mobile.png", import.meta.url).pathname,
    fullPage: true,
  });
  await button("Customize columns").click();
  await page
    .getByRole("navigation", { name: "Column editor sections" })
    .getByRole("button", { name: /Columns/ })
    .click();
  await button("Add column to view").click();
  await pick("Duration");
  await button("Back to fields").click();
  await pick("Duration");
  await pick("Smallest");
  await page
    .getByRole("navigation", { name: "Column editor sections" })
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await page
    .locator(".qt-columns-preview")
    .getByText("Min Duration", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: new URL("../.context/columns-mobile.png", import.meta.url).pathname,
    fullPage: true,
  });
  await button("Apply columns").click();
  await page
    .getByLabel("Aggregation for Min Duration", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Grouping browser checks passed: SELECT, source WHERE, HAVING, metrics, undo/redo, mode restoration, saved defaults, sharing, column editor, and mobile.",
  );
} catch (error) {
  await page.screenshot({
    path: new URL("../.context/grouping-failure.png", import.meta.url).pathname,
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
