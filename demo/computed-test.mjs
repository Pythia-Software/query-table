// Start npm run demo first. QT_DEMO_URL can also point at the production preview.
// QT_BROWSER_CHANNEL=chrome uses installed Chrome instead of Playwright Chromium.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.QT_BROWSER_CHANNEL
    ? { channel: process.env.QT_BROWSER_CHANNEL }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
  const open = () =>
    page.getByRole("button", { name: "Edit columns", exact: true }).click();
  const preview = () => page.locator(".qt-preview-summary").waitFor();
  await open();
  await preview();
  assert.match(
    await page.locator(".qt-preview-summary").innerText(),
    /40 of 40 matching rows/,
  );
  await page.getByRole("spinbutton", { name: "Rows to process" }).fill("10");
  await page.waitForFunction(() =>
    document
      .querySelector(".qt-preview-summary")
      ?.textContent?.includes("10 of 40"),
  );
  await page
    .getByRole("checkbox", { name: "Include Worker", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Cancel layout changes", exact: true })
    .click();
  await open();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Include Worker", exact: true })
      .isChecked(),
    false,
  );
  await page
    .getByRole("button", { name: "＋ Computed column", exact: true })
    .click();
  await page.getByLabel("Column name", { exact: true }).fill("Job prefix");
  const editor = page.getByRole("textbox", {
    name: "Computed column formula",
    exact: true,
  });
  await editor.fill('REGEX_EXTRACT([job_name], "^([^-]+)", 1)');
  await preview();
  await page
    .getByRole("button", { name: "Inspect match", exact: true })
    .first()
    .click();
  assert.ok(await page.locator(".qt-regex-inspector mark").innerText());
  await page
    .getByRole("button", { name: "Save definition & add column", exact: true })
    .click();
  await page.getByText("Definition saved.", { exact: false }).waitFor();
  await page
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  await page.waitForFunction(() => {
    const cells = [
      ...document.querySelectorAll('td[data-qt-field^="@computed/"]'),
    ];
    return (
      cells.length &&
      cells.every((c) => !["Error", "Calculating…"].includes(c.textContent))
    );
  });
  const values = await page
    .locator('td[data-qt-field^="@computed/"]')
    .allTextContents();
  assert.ok(values.includes("pivot"));
  const token = new URL(page.url()).searchParams.get("q");
  const saved = JSON.parse(Buffer.from(token, "base64url").toString());
  assert.ok(JSON.stringify(saved).includes("@computed/"));
  assert.ok(!JSON.stringify(saved).includes("REGEX"));
  await open();
  await page
    .locator(".qt-catalogue-item button")
    .filter({ hasText: "Job prefix" })
    .click();
  await page
    .getByRole("button", { name: "Edit definition", exact: true })
    .click();
  await editor.fill("UPPER([job_name])");
  await preview();
  await page
    .getByRole("button", { name: "Save shared definition", exact: true })
    .click();
  await page.getByText("Definition saved.", { exact: false }).waitFor();
  await page
    .getByRole("button", { name: "Cancel layout changes", exact: true })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('td[data-qt-field^="@computed/"]')].some(
      (c) => c.textContent === "PIVOT-REFRESH",
    ),
  );
  // A catastrophic native regex is killed by the owning thread; the editor stays responsive.
  await open();
  await page
    .getByRole("button", { name: "＋ Computed column", exact: true })
    .click();
  await editor.fill('REGEX_TEST(CONCAT(RPAD("a", 30000, "a"), "!"), "(a+)+$")');
  await page
    .getByText("Formula timed out.", { exact: false })
    .waitFor({ timeout: 10000 });
  await editor.fill("LEFT([job_name], 3)");
  await preview();
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page
      .getByRole("button", { name: "Apply columns", exact: true })
      .isVisible(),
  );
  // Repair a dangling query reference under the original ID, without adding a second column.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const repairUrl = new URL(
    process.env.QT_DEMO_URL ?? "http://localhost:5179/",
  );
  repairUrl.searchParams.set(
    "q",
    Buffer.from(
      JSON.stringify({ s: [["@computed/missing-original"]], l: 100 }),
    ).toString("base64url"),
  );
  await page.goto(repairUrl.toString());
  await open();
  await page
    .getByRole("button", { name: "Edit definition", exact: true })
    .click();
  await page.getByLabel("Column name", { exact: true }).fill("Repaired prefix");
  assert.equal(await editor.innerText(), "");
  await editor.fill("LEFT([job_name], 3)");
  await preview();
  await page
    .getByRole("button", { name: "Save definition & add column", exact: true })
    .click();
  await page.getByText("Definition saved.", { exact: false }).waitFor();
  assert.equal(await page.locator(".qt-editor-columns li").count(), 1);
  await page
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        'td[data-qt-field="@computed/missing-original"]',
      ),
    ].some((c) => c.textContent === "piv"),
  );
  const repairedQuery = JSON.parse(
    Buffer.from(
      new URL(page.url()).searchParams.get("q"),
      "base64url",
    ).toString(),
  );
  assert.deepEqual(repairedQuery.s, [["@computed/missing-original"]]);
  assert.deepEqual(errors, []);
  console.log(
    "Computed editor: sampling, frequencies, draft cancellation, regex inspector, shared updates, ID persistence, worker timeout/recovery, mobile layout, missing-definition repair passed.",
  );
} finally {
  await browser.close();
}
