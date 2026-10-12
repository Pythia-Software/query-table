import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = new URL("../.context/date-metrics/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const base = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1840, height: 1300 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/date-metrics-workbench`);
  const dashboard = page.locator(".qt-metrics");
  const daily = dashboard
    .locator(".qt-metric")
    .filter({ hasText: "Runs by day" });
  const average = dashboard
    .locator(".qt-metric")
    .filter({ hasText: "Average duration by day" });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".qt-metrics .qt-metric-mark").length === 21,
  );
  assert.equal(await daily.locator(".qt-metric-mark").count(), 14);
  assert.equal(await average.locator(".qt-metric-mark").count(), 7);
  assert.match(await average.innerText(), /7 missing\/error points/);
  await page
    .getByRole("button", { name: "Collapse Table", exact: true })
    .click();
  await page.screenshot({ path: `${output}/dashboard.png` });

  async function openDaily() {
    await page
      .getByRole("button", { name: "Edit metrics", exact: true })
      .click();
    await page.getByLabel("Editing metric").selectOption("daily-runs");
    const grouping = page
      .locator(".qt-metric-settings > summary")
      .filter({ hasText: "Grouping" });
    if (!(await grouping.evaluate((el) => el.parentElement.open)))
      await grouping.click();
  }
  const preview = page.locator(".qt-metric-preview-card");
  const toggle = page.getByRole("checkbox", {
    name: "Include empty dates",
    exact: true,
  });
  async function marks(count) {
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll(".qt-metric-preview-card .qt-metric-mark")
          .length === n,
      count,
    );
  }
  await openDaily();
  await marks(14);
  assert.equal(await page.getByLabel("Date interval").inputValue(), "day");
  assert.equal(
    await page.getByLabel("Complete dates across").inputValue(),
    "query",
  );
  await page
    .locator(".qt-metrics-editor")
    .screenshot({ path: `${output}/workbench.png` });
  await toggle.uncheck();
  await marks(7);
  await page
    .locator(".qt-metrics-editor")
    .screenshot({ path: `${output}/workbench-without-empty.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  assert.equal(await daily.locator(".qt-metric-mark").count(), 14);
  await openDaily();
  assert.ok(await toggle.isChecked());
  await toggle.uncheck();
  await marks(7);
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".qt-metrics .qt-metric-mark").length === 14,
  );
  await page.reload();
  await openDaily();
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await marks(14);
  await page.getByLabel("Complete dates across").selectOption("observed");
  await marks(12);
  await page.getByLabel("Complete dates across").selectOption("custom");
  await page.getByLabel("Empty dates start").fill("2026-10-01");
  await page.getByLabel("Empty dates end").fill("2026-10-14");
  await marks(14);
  await page.getByLabel("Date interval").selectOption("week");
  await marks(3);
  await page.getByLabel("Date interval").selectOption("day");
  await page.getByLabel("Complete dates across").selectOption("query");
  await marks(14);
  await page.getByLabel("Editing metric").selectOption("daily-duration");
  await marks(7);
  assert.match(await preview.innerText(), /7 missing\/error points/);
  await page
    .locator(".qt-metrics-editor")
    .screenshot({ path: `${output}/workbench-average.png` });
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();

  // The applied definition is also restored from a copied URL in a fresh context.
  const shared = await browser.newPage();
  await shared.goto(page.url());
  await shared
    .getByRole("button", { name: "Edit metrics", exact: true })
    .click();
  await shared.getByLabel("Editing metric").selectOption("daily-runs");
  await shared
    .locator(".qt-metric-settings > summary")
    .filter({ hasText: "Grouping" })
    .click();
  assert.ok(await shared.getByLabel("Include empty dates").isChecked());
  await shared.getByLabel("Remove grouping 1").click();
  assert.equal(await shared.getByLabel("Date interval").count(), 0);
  await shared.getByLabel("Add grouping").selectOption("enqueued_at");
  assert.equal(await shared.getByLabel("Date interval").inputValue(), "exact");
  assert.ok(await shared.getByLabel("Include empty dates").isDisabled());
  await shared.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(`${base}/date-metrics-workbench`);
  await mobile
    .getByRole("button", { name: "Edit metrics", exact: true })
    .click();
  await mobile.getByLabel("Editing metric").selectOption("daily-runs");
  await mobile
    .locator(".qt-metric-settings > summary")
    .filter({ hasText: "Grouping" })
    .click();
  await mobile.getByLabel("Include empty dates").scrollIntoViewIfNeeded();
  assert.ok(await mobile.getByLabel("Include empty dates").isChecked());
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({ path: `${output}/workbench-mobile.png` });
  await mobile.close();
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  assert.equal(await page.locator(".qt-metric-library-chip").count(), 15);
  assert.deepEqual(errors, []);
  console.log(
    "Date metric workbench: dashboard, preview, intervals, ranges, Apply/Cancel, reload, shared URL, grouping reset, and mobile passed.",
  );
} finally {
  await browser.close();
}
