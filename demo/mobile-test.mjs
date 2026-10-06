import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const url = process.env.QT_DEMO_URL ?? "http://localhost:5179/";
const screenshots = new URL("../.context/", import.meta.url);
await mkdir(screenshots, { recursive: true });

const denseUrl = new URL(url);
denseUrl.searchParams.set("q", Buffer.from(JSON.stringify({
  s: [["job_name"], ["platform"], ["overall"], ["total_ms"]],
  w: [{ field: "job_name", op: "contains", value: "o" }, { field: "total_ms", op: ">", value: "1000" }],
  o: [{ field: "enqueued_at", dir: "desc" }, { field: "job_name", dir: "asc" }],
  l: 50,
  g: [
    { id: "count", op: "count", groupBy: [] },
    { id: "avg", op: "avg", field: "total_ms", groupBy: [] },
    { id: "platform", op: "count", groupBy: ["platform"] },
  ],
})).toString("base64url"));

async function checkSheet(page) {
  const sheet = page.locator(".qt-sheet").last();
  await sheet.waitFor();
  await page.waitForTimeout(220);
  const bounds = await sheet.boundingBox();
  const viewport = page.viewportSize();
  assert(bounds && viewport);
  assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "Sheet fits horizontally");
  assert(bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1, "Sheet fits vertically");
  assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
  return sheet;
}

async function reorderFirst(page, root, browserName) {
  await root.scrollIntoViewIfNeeded();
  const handles = root.locator(".qt-reorder-handle");
  if (page.viewportSize().height <= 600) {
    await handles.first().focus();
    await handles.first().press("ArrowDown");
    return;
  }
  const first = await handles.first().boundingBox();
  const last = await handles.last().boundingBox();
  const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  const end = { x: last.x + last.width / 2, y: last.y + last.height / 2 };
  if (browserName === "Chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8 }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  }
}

function reorderedFirst(items, viewport) {
  return viewport.height > 600 ? [...items.slice(1), items[0]] : [items[1], items[0], ...items.slice(2)];
}

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 760, height: 1024 }, { width: 844, height: 390 }]) {
      const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForSelector("tbody .qt-row");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width, "Page must not scroll sideways");
      const headers = () => page.locator(".qt-th-label").allTextContents();
      const before = await headers();
      for (const button of await page.locator(".qt-qb-state-bar .qt-btn").all()) {
        assert((await button.boundingBox()).height <= 34, "Top toolbar buttons use compact 32px controls");
      }
      const caret = await page.locator("svg.qt-qb-collapse-caret").boundingBox();
      assert.equal(caret.width, 14, "Query builder collapse caret is a compact SVG icon");
      assert.equal(caret.height, 14);
      for (const sectionCaret of await page.locator("svg.qt-qt-section-toggle-caret").all()) {
        const bounds = await sectionCaret.boundingBox();
        assert.equal(bounds.width, 14, "Table and metrics collapse carets match the query builder");
        assert.equal(bounds.height, 14);
      }
      assert.deepEqual(await page.locator(".qt-qb-row--select .qt-qb-section-header button").allTextContents(), ["Add", "", "Reset"]);

      await page.locator(".qt-qb").evaluate((builder) => builder.style.setProperty("--qt-accent", "#8b1d42"));
      await page.getByRole("button", { name: "Customize columns", exact: true }).click();
      let sheet = await checkSheet(page);
      assert.equal(await page.locator(".qt-qb .qt-reorder-trigger").count(), 0, "Ordering has no separate buttons");
      assert.equal(await sheet.evaluate((element) => getComputedStyle(element).getPropertyValue("--qt-accent")), "#8b1d42", "Portalled sheets preserve scoped themes");
      await sheet.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
      await page.locator(".qt-qb").evaluate((builder) => builder.style.removeProperty("--qt-accent"));
      const columnList = page.locator(".qt-query-reorder-list--columns");
      await reorderFirst(page, columnList, name);
      const arranged = reorderedFirst(before, viewport);
      assert.deepEqual(await headers(), arranged, "Handles update the table order");
      assert((await columnList.locator(".qt-reorder-item").first().boundingBox()).height <= 34, "Column chips use compact spacing");
      if (name === "Chromium" && viewport.width === 390) await page.screenshot({ path: new URL("mobile-arrange.png", screenshots).pathname });
      assert.equal(await page.evaluate(() => document.body.style.overflow), "");

      await page.getByRole("button", { name: "Add filter", exact: true }).click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.getByRole("textbox", { name: "Search fields", exact: true }).evaluate((input) => input === document.activeElement), false, "Picker does not force the keyboard open");
      const item = sheet.locator(".qt-picker-item").first();
      await item.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1 });
      await item.dispatchEvent("pointercancel", { pointerType: "touch", pointerId: 1 });
      assert.equal(await page.locator("[data-qt-filter]").count(), 0, "Scrolling a picker must not select a field");
      await item.click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.locator(".qt-filter-editor").count(), 1, "A new filter opens its editor immediately");
      await sheet.locator(".qt-op-trigger").click();
      const conditionSheet = await checkSheet(page);
      assert.equal(await page.locator(".qt-sheet").count(), 2);
      await conditionSheet.locator(".qt-op-cell").first().click();
      assert.equal(await page.locator(".qt-sheet").count(), 1);
      await sheet.getByRole("button", { name: /^Close Filter by/ }).click();
      await page.locator("[data-qt-filter]").click();
      sheet = await checkSheet(page);
      if (name === "Chromium" && viewport.width === 390) await page.screenshot({ path: new URL("mobile-filter.png", screenshots).pathname });
      await sheet.getByRole("button", { name: /^Remove .* filter$/ }).click();

      await page.getByRole("button", { name: "Customize columns", exact: true }).click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.locator(".qt-selected-panel").isVisible(), true);
      assert.equal(await sheet.locator(".qt-catalogue-panel").isVisible(), false);
      if (viewport.height > 600) assert((await sheet.boundingBox()).height < 550, "Selected sheet fits its content instead of reserving an empty workbench");
      assert.equal(await sheet.locator(".qt-reorder-trigger").count(), 0, "Editor has no separate Arrange action");
      assert.equal(await sheet.locator(".qt-editor-columns .qt-reorder-handle").count(), before.length);
      await reorderFirst(page, sheet.locator(".qt-editor-columns"), name);
      const draft = reorderedFirst(arranged, viewport);
      assert.deepEqual(await sheet.locator(".qt-column-name").allTextContents(), draft, "Leading handles reorder the draft directly");
      assert.deepEqual(await headers(), arranged, "Draft order does not change the table before Apply");
      assert((await sheet.locator(".qt-editor-columns li").first().boundingBox()).height <= 48, "Editor rows stay compact with touch-sized handles");
      if (name === "Chromium" && viewport.width === 390) await page.screenshot({ path: new URL("mobile-column-editor.png", screenshots).pathname });
      await sheet.getByRole("button", { name: "Catalogue", exact: true }).click();
      assert.equal(await sheet.locator(".qt-catalogue-panel").isVisible(), true);
      assert.equal(await sheet.locator(".qt-selected-panel").isVisible(), false);
      await sheet.locator(".qt-catalogue-panel .qt-catalogue-list button").first().click();
      assert.equal(await sheet.locator(".qt-column-workbench").isVisible(), true);
      await sheet.getByRole("button", { name: "Apply columns", exact: true }).click();
      assert.deepEqual(await headers(), draft, "Apply commits inline column ordering");
      await page.getByRole("button", { name: "Customize columns", exact: true }).click();
      sheet = await checkSheet(page);
      await sheet.locator(".qt-reorder-handle").first().press("ArrowDown");
      await sheet.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
      assert.deepEqual(await headers(), draft, "Cancel discards inline column ordering");

      await page.getByRole("button", { name: /^Edit Sort by Enqueued/ }).click();
      sheet = await checkSheet(page);
      await sheet.getByRole("combobox", { name: "Direction", exact: true }).selectOption("asc");
      assert.match(await page.getByRole("button", { name: /^Edit Sort by Enqueued/ }).textContent(), /Ascending/);
      await sheet.getByRole("button", { name: "Configure regex extract for Enqueued", exact: true }).click();
      const extraction = await checkSheet(page);
      await extraction.getByLabel("Regex extract for Enqueued", { exact: true }).fill("(.+)");
      await extraction.getByRole("button", { name: "Apply extraction", exact: true }).click();
      await sheet.getByRole("combobox", { name: "Null values", exact: true }).selectOption("first");
      await sheet.getByRole("button", { name: "Configure regex extract for Enqueued", exact: true }).click();
      await page.getByRole("button", { name: "Remove regex extract for Enqueued", exact: true }).click();
      assert.equal(await sheet.locator(".qt-mobile-form input").count(), 0, "Optional extraction clears without removing the sort");
      await sheet.getByRole("button", { name: "Close Sort by Enqueued", exact: true }).click();
      await page.getByRole("button", { name: "Add metric", exact: true }).click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.locator(".qt-mobile-form").count(), 1, "A new metric opens directly into setup");
      await sheet.getByRole("combobox", { name: "Aggregation function", exact: true }).selectOption("avg");
      await sheet.getByRole("combobox", { name: "Metric measure", exact: true }).selectOption("total_ms");
      await sheet.getByRole("button", { name: "Add grouping field", exact: true }).click();
      const groupSheet = await checkSheet(page);
      await groupSheet.locator(".qt-picker-item").filter({ has: page.locator(".qt-picker-label", { hasText: /^Platform$/ }) }).click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.getByRole("button", { name: "Remove Platform grouping", exact: true }).count(), 1);
      await sheet.getByRole("button", { name: "Remove Platform grouping", exact: true }).click();
      await sheet.getByRole("button", { name: /^Close/ }).click();
      for (const section of await page.locator(".qt-qb-row--filters .qt-qb-section-header, .qt-qb-row--sort .qt-qb-section-header, .qt-qb-row--metrics .qt-qb-section-header").all()) {
        const add = await section.locator(":scope > .qt-split-btn, :scope > .qt-add").first().boundingBox();
        const header = await section.boundingBox();
        assert(add && header && add.height >= 32 && add.height <= 34, "Header actions use compact 32px controls");
        assert(header.height <= 34, "Section actions fit a single compact header row");
      }
      await page.locator(".qt-qb-row--metrics .qt-mobile-filter").click();
      sheet = await checkSheet(page);
      await sheet.getByRole("button", { name: "Remove metric", exact: true }).click();

      await page.locator(".qt-th-label").first().click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.getByRole("menu").count(), 1);
      await sheet.getByRole("button", { name: /^Close/ }).click();

      await page.getByRole("button", { name: "Saved", exact: true }).click();
      sheet = await checkSheet(page);
      await sheet.getByRole("button", { name: "Close Saved queries", exact: true }).click();
      await page.getByRole("button", { name: "Auto-Update", exact: true }).click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.locator(".qt-auto-refresh-select").count(), 2);
      await sheet.getByRole("button", { name: "Close Auto-update", exact: true }).click();

      const cell = page.locator("tbody .qt-row .qt-cell:not(.qt-checkbox-cell)").first();
      await cell.click();
      sheet = await checkSheet(page);
      assert.equal(await sheet.getByRole("menu").count(), 1);
      await sheet.getByRole("button", { name: /^Close/ }).click();
      await page.goto(denseUrl.href);
      await page.waitForSelector(".qt-metric-big-value");
      for (const header of await page.locator(".qt-qb-section-header").all()) {
        assert((await header.boundingBox()).height <= 34, "Clause headers use compact 32px controls even at 320px");
      }
      for (const row of await page.locator(".qt-qb-body > .qt-qb-row:not(:first-child)").all()) {
        assert.equal(await row.evaluate((element) => getComputedStyle(element).borderTopStyle), "solid", "Clauses have visible horizontal separators");
        assert.equal(await row.evaluate((element) => getComputedStyle(element).paddingTop), "10px", "Keyword sections have deliberate breathing room");
      }
      assert.equal(await page.locator(".qt-mobile-clause-delete, .qt-qb-row--filters .qt-reorder-handle").count(), 0, "Filters have no ordering handles and summaries have no trash icons");
      for (const button of await page.locator(".qt-mobile-filter").all()) {
        const bounds = await button.boundingBox();
        assert(bounds.height >= 32 && bounds.height <= 34, "Chip edit buttons are actually shorter, not just less padded");
        assert.equal(await button.evaluate((element) => getComputedStyle(element).paddingTop), "0px", "Chip actions have no vertical padding");
        assert.equal(await button.evaluate((element) => getComputedStyle(element).paddingBottom), "0px");
      }
      const scalarCards = page.locator(".qt-metric--gb0");
      const firstCard = await scalarCards.first().boundingBox();
      const secondCard = await scalarCards.last().boundingBox();
      assert(Math.abs(firstCard.y - secondCard.y) <= 1, "Simple metrics share a compact two-column row");
      assert(firstCard.x + firstCard.width <= secondCard.x, "Metric cards do not overlap");
      const groupedCard = await page.locator(".qt-metric--gb1").boundingBox();
      assert(groupedCard.width > firstCard.width * 1.8, "Grouped metrics retain the full available width");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width, "Dense queries do not overflow the viewport");
      await page.locator(".qt-metrics").scrollIntoViewIfNeeded();
      if (name === "Chromium" && viewport.width === 390) await page.screenshot({ path: new URL("mobile-dense-metrics.png", screenshots).pathname });
      for (const section of ["sort", "metrics"]) {
        const root = page.locator(`.qt-qb-row--${section} .qt-query-reorder-list`);
        const beforeOrder = await root.locator(".qt-mobile-filter strong").allTextContents();
        await reorderFirst(page, root, name);
        assert.deepEqual(await root.locator(".qt-mobile-filter strong").allTextContents(), reorderedFirst(beforeOrder, viewport), "Inline handles change live sort and metric order");
        assert.equal(await page.locator(".qt-sheet").count(), 0, "Dragging does not open the editor");
      }
      for (const [section, expected] of [["filters", 2], ["sort", 2], ["metrics", 3]]) {
        const clauses = page.locator(`.qt-qb-row--${section} .qt-mobile-filter`);
        await clauses.first().click();
        sheet = await checkSheet(page);
        const remove = section === "metrics" ? sheet.getByRole("button", { name: "Remove metric", exact: true }) : sheet.getByRole("button", { name: section === "filters" ? /^Remove .* filter$/ : /^Remove .* sort$/ });
        await remove.click();
        assert.equal(await clauses.count(), expected - 1, "Deletion from the editor removes only the targeted clause");
        assert.equal(await page.locator(".qt-sheet").count(), 0, "Deleting closes the editor");
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await page.waitForFunction(({ section, expected }) => document.querySelectorAll(`.qt-qb-row--${section} .qt-mobile-filter`).length === expected, { section, expected });
        assert.equal(await clauses.count(), expected, "Editor deletion supports Undo");
      }
      assert.deepEqual(errors, [], "No browser runtime errors");
      console.log(`PASS ${name} ${viewport.width}×${viewport.height}: sheets, touch ordering, filters, native sorts, metrics/grouping, compact headers/results, columns, cell actions`);
      await page.close();
    }
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await desktop.goto(denseUrl.href);
    await desktop.waitForSelector(".qt-chip--sort");
    assert.equal(await desktop.locator(".qt-mobile-filter").count(), 0, "Desktop retains inline chip editors");
    assert.equal(await desktop.locator(".qt-qb-row--select .qt-qb-section-header").evaluate((header) => getComputedStyle(header).display), "contents", "Desktop columns use the same inline layout as other clauses");
    const columns = desktop.locator(".qt-qb-row--select");
    const keyword = await columns.locator(".qt-qb-kw").boundingBox();
    const firstColumn = await columns.locator(".qt-chip--col").first().boundingBox();
    const filterKeyword = await desktop.locator(".qt-qb-row--filters .qt-qb-kw").boundingBox();
    const firstFilter = await desktop.locator(".qt-qb-row--filters .qt-chip--where").first().boundingBox();
    assert(Math.abs(keyword.y + keyword.height / 2 - firstColumn.y - firstColumn.height / 2) <= 1, "Desktop columns share the keyword baseline");
    assert(Math.abs(firstColumn.x - firstFilter.x) <= 1 && Math.abs(keyword.x - filterKeyword.x) <= 1, "Column chips align with other clause contents");
    assert.deepEqual(await columns.locator(".qt-split-btn button, :scope > button").allTextContents(), ["add column", "", "reset"], "Desktop split-button actions follow the column chips");
    assert.equal(await desktop.locator(".qt-qb-row--filters .qt-qb-section-header").evaluate((header) => getComputedStyle(header).display), "contents", "Other desktop sections retain their inline layout");
    for (const row of await desktop.locator(".qt-qb-body > .qt-qb-row:not(:first-child)").all()) {
      assert.equal(await row.evaluate((element) => getComputedStyle(element).borderTopStyle), "solid", "Desktop clauses also have horizontal separators");
    }
    await desktop.locator(".qt-chip--sort").first().getByRole("button", { name: "desc", exact: true }).click();
    assert.equal(await desktop.locator(".qt-chip--sort").first().getByRole("button", { name: "asc", exact: true }).count(), 1);
    await desktop.locator(".qt-chip--agg").first().getByRole("combobox", { name: "Aggregation function", exact: true }).selectOption("sum");
    await desktop.locator(".qt-chip--agg").first().getByRole("combobox", { name: "Metric measure", exact: true }).selectOption("total_ms");
    assert.equal(await desktop.locator(".qt-sheet").count(), 0, "Desktop editing does not open mobile sheets");
    await desktop.getByRole("button", { name: "Configure regex extract for Job", exact: true }).click();
    const regexDialog = desktop.getByRole("dialog", { name: "Regex extraction for Job", exact: true });
    await regexDialog.getByLabel("Regex extract for Job", { exact: true }).fill("^(.)");
    await regexDialog.getByRole("button", { name: "Apply extraction", exact: true }).waitFor();
    await desktop.waitForFunction(() => !document.querySelector(".qt-sort-extract-footer .qt-btn--primary").disabled);
    assert.match(await regexDialog.locator("tbody code").first().textContent(), /^.$/, "Regex extraction previews the first capture from real sampled values");
    await regexDialog.getByLabel("Regex extract for Job", { exact: true }).fill("[");
    assert(await regexDialog.getByRole("button", { name: "Apply extraction", exact: true }).isDisabled(), "Invalid regexes cannot be committed");
    await regexDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await desktop.locator(".qt-chip--sort input").count(), 0, "Regex configuration no longer occupies inline sort chips");
    for (const [trigger, field, result] of [
      [desktop.getByRole("button", { name: "Add column", exact: true }), "is_starred", desktop.locator(".qt-chip--col")],
      [desktop.getByRole("button", { name: "Add filter", exact: true }), "job_name", desktop.locator(".qt-chip--where")],
      [desktop.getByRole("button", { name: "Add sort", exact: true }), "platform", desktop.locator(".qt-chip--sort")],
      [desktop.locator(".qt-chip--agg").first().getByRole("button", { name: "Add grouping field", exact: true }), "platform", desktop.locator(".qt-chip--agg").first().locator(".qt-chip-agg-group")],
    ]) {
      const before = await result.count();
      await trigger.click();
      const search = desktop.getByRole("textbox", { name: "Search fields", exact: true });
      await search.fill(field);
      assert(await search.evaluate((element) => element === document.activeElement), "Desktop picker search has focus before selecting");
      await desktop.locator(`.qt-picker-item[title="${field}"]`).click();
      assert.equal(await result.count(), before + 1, `${field} selection commits before the picker closes`);
      assert.equal(await desktop.locator(".qt-picker").count(), 0);
    }
    console.log(`PASS ${name} desktop: inline filters, sorts, metric editors, and click-based field picking`);
    await desktop.close();
  } finally {
    await browser.close();
  }
}
