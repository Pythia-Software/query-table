import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = new URL("../.context/date-metrics/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${process.env.QT_DEMO_URL ?? "http://localhost:5179"}/date-metrics`,
  );
  const toggle = page.getByRole("checkbox", { name: "Include empty dates" });
  const buckets = page.locator(".date-prototype-bucket");
  const chart = page.getByTestId("date-metric-chart");
  await toggle.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".qt-metric-plot svg")?.getBoundingClientRect()
        .width > 100,
  );
  assert.equal(await buckets.count(), 14);
  assert.equal(
    await page.locator('.date-prototype-bucket[data-empty="true"]').count(),
    7,
  );
  assert.equal(await chart.locator(".qt-metric-mark").count(), 14);
  await chart.locator(".qt-metric-mark").first().click();
  assert.match(
    await page.locator(".date-prototype-inspected").innerText(),
    /Oct 1 · 0 matching orders · Empty date bucket/,
  );
  await chart.locator(".qt-metric-mark").first().press("Escape");
  await toggle.uncheck();
  assert.equal(await buckets.count(), 7);
  assert.equal(await chart.locator(".qt-metric-mark").count(), 7);
  await page.screenshot({
    path: `${output}/without-empty-dates.png`,
    fullPage: true,
  });
  await toggle.check();
  await page.screenshot({
    path: `${output}/include-empty-dates.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Apply metric", exact: true }).click();
  assert.ok(
    await page
      .getByRole("button", { name: "Apply metric", exact: true })
      .isDisabled(),
  );
  await toggle.uncheck();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(await toggle.isChecked());

  await page.getByLabel("Measure", { exact: true }).selectOption("avg");
  assert.equal(await chart.locator(".qt-metric-mark").count(), 7);
  assert.equal(
    await page
      .locator('.date-prototype-bucket[data-empty="true"] strong')
      .first()
      .innerText(),
    "—",
  );
  const path = await chart.locator("path[stroke-width='2']").getAttribute("d");
  assert.equal((path.match(/M/g) ?? []).length, 4);
  await page.screenshot({
    path: `${output}/average-empty-dates.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Table", exact: true }).click();
  assert.equal(await chart.locator("tbody tr").count(), 14);
  await page.getByRole("button", { name: "Bars", exact: true }).click();
  assert.equal(await chart.locator(".qt-metric-mark").count(), 7);
  await page.getByLabel("Measure", { exact: true }).selectOption("count");
  assert.equal(await chart.locator(".qt-metric-mark").count(), 14);
  await page.getByRole("button", { name: "Line", exact: true }).click();

  await page.getByLabel("Date interval").selectOption("week");
  assert.equal(await buckets.count(), 3);
  await page.getByLabel("Date interval").selectOption("month");
  assert.equal(await buckets.count(), 1);
  await page.getByLabel("Date interval").selectOption("day");
  await page.getByLabel("Date range", { exact: true }).selectOption("observed");
  assert.equal(await buckets.count(), 12);
  await page.getByLabel("Date range", { exact: true }).selectOption("custom");
  await page.getByLabel("Range start").fill("2026-10-04");
  await page.getByLabel("Range end").fill("2026-10-08");
  assert.equal(await buckets.count(), 5);
  await page.getByLabel("Range end").fill("2026-10-03");
  assert.match(await page.getByRole("alert").innerText(), /end date/);
  assert.ok(
    await page
      .getByRole("button", { name: "Apply metric", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("Date range", { exact: true }).selectOption("query");

  await page.getByLabel("Example data").selectOption("empty");
  assert.equal(await buckets.count(), 14);
  assert.equal(
    await page.locator('.date-prototype-bucket[data-empty="true"]').count(),
    14,
  );
  await page.getByLabel("Date range", { exact: true }).selectOption("observed");
  assert.equal(await buckets.count(), 0);
  await page.getByLabel("Date range", { exact: true }).selectOption("query");
  await page.getByLabel("Example data").selectOption("sparse");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  const dateTicks = await chart
    .locator(".qt-metric-axis")
    .evaluateAll((elements) =>
      elements
        .filter((element) => /^Oct \d{2}$/.test(element.textContent))
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        }),
    );
  for (let i = 1; i < dateTicks.length; i++)
    assert.ok(dateTicks[i].left > dateTicks[i - 1].right);
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Date metric prototype passed: completion, chart marks and gaps, all displays, ranges, apply/cancel, empty population, mobile layout. Screenshots: .context/date-metrics/",
  );
} finally {
  await browser.close();
}
