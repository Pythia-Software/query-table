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
  async function openDaily(target = page) {
    await target
      .getByRole("button", { name: "Edit metrics", exact: true })
      .click();
    await target.getByLabel("Editing metric").selectOption("daily-runs");
    const grouping = target
      .locator(".qt-metric-settings > summary")
      .filter({ hasText: "Grouping" });
    if (!(await grouping.evaluate((el) => el.parentElement.open)))
      await grouping.click();
  }
  async function marks(count) {
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll(".qt-metric-preview-card .qt-metric-mark")
          .length === n,
      count,
    );
  }
  const preview = page.locator(".qt-metric-preview-card");
  await page.goto(`${base}/date-metrics-workbench`);
  await openDaily();
  const zone = page.getByLabel("Grouping timezone");
  assert.equal(await zone.inputValue(), "UTC");
  await zone.fill("America/Denver");
  await marks(15);
  assert.match(await preview.innerText(), /Sep 30/);
  assert.match(
    await preview.locator(".qt-metric-mark").first().getAttribute("aria-label"),
    /2026-09-30 00:00 -06:00/,
  );

  await zone.fill("Invalid/Zone");
  await page
    .getByText(
      "Use a valid IANA grouping timezone, such as America/Denver or UTC.",
      { exact: true },
    )
    .first()
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Apply metrics", exact: true })
      .isDisabled(),
  );
  await zone.fill("America/Denver");
  await marks(15);
  await page.getByLabel("Complete dates across").selectOption("custom");
  await page.getByLabel("Empty dates start").fill("2026-10-01");
  await page.getByLabel("Empty dates end").fill("2026-10-14");
  await marks(14);
  assert.match(
    await preview.locator(".qt-metric-mark").first().getAttribute("aria-label"),
    /2026-10-01 00:00 -06:00/,
  );
  assert.doesNotMatch(await preview.innerText(), /Sep 30/);

  await zone.fill("Pacific/Auckland");
  await page.waitForFunction(() =>
    document
      .querySelector(".qt-metric-preview-card .qt-metric-mark")
      ?.getAttribute("aria-label")
      ?.includes("+13:00"),
  );
  const shifted = preview
    .locator(".qt-metric-mark")
    .filter({ has: page.locator("circle") });
  const labels = await shifted.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label")),
  );
  assert.ok(
    labels.some((label) => /2026-10-03 00:00 \+13:00\n12\n12 rows/.test(label)),
  );
  assert.ok(
    labels.some((label) => /2026-10-02 00:00 \+13:00\n0\n0 rows/.test(label)),
  );

  await zone.fill("Asia/Kathmandu");
  await page.waitForFunction(() =>
    document
      .querySelector(".qt-metric-preview-card .qt-metric-mark")
      ?.getAttribute("aria-label")
      ?.includes("+05:45"),
  );
  assert.match(await preview.innerText(), /Oct 01/);
  assert.doesNotMatch(await preview.innerText(), /Sep 30/);
  await zone.fill("America/Denver");
  await page.waitForFunction(() =>
    document
      .querySelector(".qt-metric-preview-card .qt-metric-mark")
      ?.getAttribute("aria-label")
      ?.includes("-06:00"),
  );
  await page.getByLabel("Date interval").selectOption("hour");
  await marks(336);
  assert.match(
    await preview.locator(".qt-metric-mark").first().getAttribute("aria-label"),
    /2026-10-01 00:00 -06:00/,
  );
  await page.getByLabel("Date interval").selectOption("day");
  await marks(14);
  await page.getByLabel("Empty dates end").scrollIntoViewIfNeeded();
  await page
    .locator(".qt-metrics-editor")
    .screenshot({ path: `${output}/timezone-workbench.png` });
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();
  await page.reload();
  await openDaily();
  assert.equal(await zone.inputValue(), "America/Denver");
  assert.equal(
    await page.getByLabel("Complete dates across").inputValue(),
    "custom",
  );
  assert.equal(
    await page.getByLabel("Empty dates start").inputValue(),
    "2026-10-01",
  );
  await marks(14);

  const shared = await browser.newPage();
  await shared.goto(page.url());
  await openDaily(shared);
  assert.equal(
    await shared.getByLabel("Grouping timezone").inputValue(),
    "America/Denver",
  );
  assert.equal(
    await shared.getByLabel("Empty dates end").inputValue(),
    "2026-10-14",
  );
  await shared.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(`${base}/date-metrics-workbench`);
  await openDaily(mobile);
  await mobile.getByLabel("Grouping timezone").fill("America/New_York");
  await mobile.getByLabel("Grouping timezone").scrollIntoViewIfNeeded();
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({ path: `${output}/timezone-mobile.png` });
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log(
    "Metric timezones: local labels, shifted timestamps, query/custom bounds, validation, hourly grouping, Apply/reload/shared URL, and mobile passed.",
  );
} finally {
  await browser.close();
}
