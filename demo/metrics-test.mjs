import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const output = new URL("../.context/metrics-production/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
  await page.waitForFunction(
    () => document.querySelectorAll(".qt-metrics > .qt-metric").length === 15,
  );
  await page.waitForTimeout(600);
  assert.deepEqual(
    await page.locator(".qt-metrics-error").allTextContents(),
    [],
  );
  assert.equal(await page.locator(".qt-metric-plot svg").count(), 8);
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
        ?.disabled,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Suggestions", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".qt-metric-workspace > aside, .qt-metric-workspace > section")
      .count(),
    4,
  );
  const dialog = page.locator(".qt-metrics-editor");
  const geometry = await dialog.boundingBox();
  assert.ok(geometry.width > 1500);
  const separator = page.getByRole("separator", {
    name: "Resize metric panes 1 and 2",
  });
  const before = await separator.getAttribute("aria-valuenow");
  await separator.focus();
  await separator.press("ArrowRight");
  assert.equal(
    Number(await separator.getAttribute("aria-valuenow")),
    Number(before) + 10,
  );
  assert.equal(await page.getByText("Dialog size", { exact: true }).count(), 0);
  assert.equal(
    await dialog.evaluate((el) => getComputedStyle(el).resize),
    "both",
  );
  await page.mouse.move(
    geometry.x + geometry.width - 3,
    geometry.y + geometry.height - 3,
  );
  await page.mouse.down();
  await page.mouse.move(
    geometry.x + geometry.width - 183,
    geometry.y + geometry.height - 83,
    { steps: 8 },
  );
  await page.mouse.up();
  assert.ok((await dialog.boundingBox()).width < geometry.width);
  assert.ok((await dialog.boundingBox()).height < geometry.height);
  // Native resize writes inline dimensions; reset must clear those as well.
  await dialog.evaluate((el) => {
    el.style.width = "1300px";
    el.style.height = "800px";
  });
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  assert.equal(
    Math.round((await dialog.boundingBox()).width),
    Math.round(geometry.width),
  );
  assert.equal(
    Math.round((await dialog.boundingBox()).height),
    Math.round(geometry.height),
  );
  assert.equal(await separator.getAttribute("aria-valuenow"), before);
  const firstName = await page
    .getByLabel("Metric name", { exact: true })
    .inputValue();
  await page.getByLabel("Metric name", { exact: true }).fill("Discarded name");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Discarded name", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
        ?.disabled,
  );
  assert.equal(
    await page.getByLabel("Metric name", { exact: true }).inputValue(),
    firstName,
  );
  await page.getByLabel("Workbench view").selectOption("dashboard");
  assert.equal(await page.locator(".qt-metric-library").count(), 0);
  await page.getByLabel("Layout metric name").fill("Production dashboard");
  await page.getByLabel("Min height in rem", { exact: true }).fill("8");
  await page.getByLabel("Min height in rem", { exact: true }).press("Tab");
  assert.equal(
    await page.getByLabel("Height in rem", { exact: true }).inputValue(),
    "8",
  );
  await page.getByLabel("Min width in rem", { exact: true }).fill("3");
  await page.getByLabel("Width in rem", { exact: true }).fill("6");
  assert.equal(
    await page.getByLabel("Width in rem", { exact: true }).inputValue(),
    "6",
  );
  await page.getByRole("button", { name: "Phone · 360", exact: true }).click();
  assert.equal(await page.getByLabel("Canvas width").inputValue(), "360");
  await page.getByLabel("Min width in rem", { exact: true }).fill("30");
  await page.getByLabel("Min width in rem", { exact: true }).press("Tab");
  const canvasWidth = (
    await page.locator(".qt-metric-layout-card").first().boundingBox()
  ).width;
  assert.ok(canvasWidth >= 480);

  await page
    .getByRole("button", { name: "Desktop · 1200", exact: true })
    .click();
  const items = page.locator(".qt-metric-layout-items > li");
  const originalOrder = await items.evaluateAll((els) =>
    els.map((el) => el.dataset.reorderId),
  );
  const worker = page.getByRole("button", {
    name: "Drag to reorder Worker ranking",
    exact: true,
  });
  await worker.scrollIntoViewIfNeeded();
  const workerBounds = await worker.boundingBox();
  await page.mouse.move(
    workerBounds.x + workerBounds.width / 2,
    workerBounds.y + workerBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    workerBounds.x + workerBounds.width / 2 + 2,
    workerBounds.y + workerBounds.height / 2 + 2,
  );
  await page.mouse.up();
  assert.deepEqual(
    await items.evaluateAll((els) => els.map((el) => el.dataset.reorderId)),
    originalOrder,
  );
  const cards = page.locator(".qt-metric-layout-card");
  await cards.nth(3).click({ position: { x: 100, y: 80 } });
  assert.equal(
    await page.getByLabel("Selected metric").inputValue(),
    "platforms",
  );
  const card = cards.nth(3);
  await card.hover();
  await card.locator("summary").filter({ hasText: "⋯" }).first().click();
  await card.getByRole("button", { name: "Edit metric", exact: true }).click();
  assert.equal(await page.getByLabel("Workbench view").inputValue(), "editor");
  assert.equal(
    await page.getByLabel("Metric name", { exact: true }).inputValue(),
    "Platform mix",
  );
  await page
    .locator(".qt-metric-settings > summary")
    .filter({ hasText: "Display" })
    .click();
  await page.getByLabel("Metric display").selectOption("value");
  assert.ok(
    await page
      .getByRole("button", { name: "Apply metrics", exact: true })
      .isDisabled(),
  );
  assert.ok(
    await page
      .getByText("Value display requires no grouping.", { exact: false })
      .count(),
  );
  await page.getByLabel("Metric display").selectOption("donut");
  await page.waitForFunction(
    () =>
      !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
        ?.disabled,
  );
  await page.screenshot({ path: `${output}/metric-editor.png` });
  await page.getByLabel("Workbench view").selectOption("dashboard");
  await page.screenshot({ path: `${output}/dashboard-layout.png` });
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();
  await page.waitForTimeout(700);
  assert.ok(
    await page
      .locator(".qt-metrics")
      .getByText("Production dashboard", { exact: true })
      .count(),
  );
  await page.reload();
  await page.waitForTimeout(900);
  assert.equal(await page.locator(".qt-metrics > .qt-metric").count(), 15);
  assert.ok(
    await page
      .locator(".qt-metrics")
      .getByText("Production dashboard", { exact: true })
      .count(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const savedWidth = (
    await page.locator(".qt-metrics > .qt-metric").first().boundingBox()
  ).width;
  assert.equal(savedWidth, canvasWidth);
  assert.ok(
    await page
      .locator(".qt-metrics")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.screenshot({ path: `${output}/dashboard.png`, fullPage: true });
  // All chart modes are real library cards; keyboard focus and hover reveal data.
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
        ?.disabled,
  );
  await page.getByLabel("Workbench view").selectOption("dashboard");
  const scatter = page
    .locator(".qt-metric-layout-card")
    .filter({ hasText: "Throughput × duration" });
  await scatter.scrollIntoViewIfNeeded();
  const mark = scatter.locator(".qt-metric-mark").first();
  await mark.hover();
  assert.match(
    await scatter.getByRole("tooltip").innerText(),
    /worker-.*\n.*\/.*\n.*rows/s,
  );
  await mark.focus();
  await mark.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(await scatter.getByRole("tooltip").count(), 0);
  assert.deepEqual(errors, []);
  // Preview geometry, reference insertion and inspection survive changing panes.
  const authoring = await browser.newPage({
    viewport: { width: 1680, height: 1050 },
  });
  authoring.on("pageerror", (e) => errors.push(e.message));
  await authoring.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
  await authoring
    .getByRole("button", { name: "Edit metrics", exact: true })
    .click();
  await authoring
    .locator(".qt-metric-library-chip")
    .filter({ hasText: "Pass rate by platform" })
    .click();
  await authoring.waitForFunction(
    () =>
      document.querySelectorAll(".qt-metric-preview-card .qt-metric-mark")
        .length === 3,
  );
  assert.equal(await authoring.getByLabel("Preview width").inputValue(), "416");
  assert.equal(
    await authoring.getByLabel("Preview height").inputValue(),
    "208",
  );
  await authoring
    .locator(".qt-metric-preview-card .qt-metric-mark")
    .nth(1)
    .press("Enter");
  assert.equal(
    await authoring.locator(".qt-metric-inspection").getAttribute("open"),
    "",
  );
  assert.match(
    await authoring.getByLabel("Inspect result group").inputValue(),
    /macos/,
  );
  await authoring
    .locator(".qt-metric-library-chip")
    .filter({ hasText: "Duration histogram" })
    .click();
  await authoring
    .locator(".qt-metric-definition .qt-metric-settings > summary")
    .filter({ hasText: "Display" })
    .click();
  assert.equal(
    await authoring.getByLabel("Metric output type").inputValue(),
    "duration",
  );
  await authoring
    .locator(".qt-metric-library-chip")
    .filter({ hasText: "Runs in scope" })
    .click();
  await authoring.getByLabel("Reference library").selectOption("functions");
  await authoring.getByLabel("Function concept").selectOption("aggregate");
  assert.equal(await authoring.locator(".qt-metric-reference-item").count(), 6);
  const expression = authoring.getByRole("textbox", {
    name: "Metric expression",
    exact: true,
  });
  await expression.fill("COUNT()");
  await expression.evaluate((el) => el.setSelectionRange(0, 7));
  await authoring.getByLabel("Search metric reference").fill("SUM");
  await authoring.locator(".qt-metric-reference-item").first().click();
  assert.equal(await expression.inputValue(), "SUM(COUNT())");
  await authoring.setViewportSize({ width: 1280, height: 900 });
  await authoring.waitForFunction(() => {
    const el = document.querySelector(".qt-metric-workspace");
    return el && el.scrollWidth <= el.clientWidth;
  });
  await authoring.close();
  assert.deepEqual(errors, []);
  console.log(
    "Production metrics browser checks passed: transactional drafts, grouped Value validation, direct card drag geometry, native dialog resizing/reset, minimum-width overflow and canvas parity, persistence, all chart modes, scatter tooltip and Escape.",
  );
} finally {
  await browser.close();
}
