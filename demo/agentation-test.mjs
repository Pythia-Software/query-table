import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = new URL(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
  url.searchParams.set("q", Buffer.from(JSON.stringify({
    s: [["job_name"], ["platform"], ["total_ms"]],
    w: [{ field: "job_name", op: "contains", value: "pivot" }],
    l: 50,
  })).toString("base64url"));
  await page.goto(url.href);
  await page.getByRole("button", { name: "Start feedback mode", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Standard", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".qt-qb-row--select .qt-qb-kw").click();
  const comment = "Example feedback: make this Columns header clearer.";
  await page.getByPlaceholder("What should change?", { exact: true }).fill(comment);
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".context/query-agentation-playground.png" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const copy = async () => {
    await page.getByRole("button", { name: "Copy feedback", exact: true }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const feedback = await copy();
  assert(feedback.includes(comment));
  assert.match(feedback, /\*\*App:\*\* query-table playground/);
  assert.match(feedback, /qt-qb-section-header/);
  assert.match(feedback, /QueryBuilder\.tsx/);
  await page.reload();
  await page.getByRole("button", { name: "Start feedback mode", exact: true }).click();
  assert((await copy()).includes(comment), "Saved notes survive reloads");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  for (const [openLabel, closeLabel] of [
    ["Customize columns", "Close column editor"],
    ["Saved", "Close Saved queries"],
    ["Sort with regex extraction", "Close sort with regex extraction"],
  ]) {
    await page.getByRole("button", { name: openLabel, exact: true }).click();
    const dialog = page.locator('.qt-modal-surface[aria-modal="true"]');
    assert(await dialog.evaluate((element) => Boolean(element.closest(".qt-demo"))), "Desktop dialogs render in place");
    await dialog.locator("[data-agentation-root]").waitFor();
    await page.getByRole("button", { name: "Start feedback mode", exact: true }).click();
    await dialog.locator("h2").click();
    const dialogComment = `Example feedback: clarify the ${openLabel} dialog.`;
    const dialogInput = page.getByPlaceholder("What should change?", { exact: true });
    await dialogInput.fill(dialogComment);
    assert(await dialogInput.evaluate((element) => element.getRootNode().activeElement === element), `${openLabel} annotations retain focus`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    assert((await copy()).includes(dialogComment), `${openLabel} annotations can be exported`);
    assert.equal(await dialog.count(), 1, "Annotating does not close a desktop dialog");
    await page.getByRole("button", { name: "Exit", exact: true }).click();
    await page.getByRole("button", { name: closeLabel, exact: true }).click();
    await page.getByRole("button", { name: "Start feedback mode", exact: true }).waitFor();
    assert.equal(await dialog.count(), 0, "Toolbar recovers after closing desktop dialogs");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".qt-qb-row--filters .qt-mobile-filter").click();
  const sheet = page.locator('.qt-modal-surface[aria-modal="true"]');
  await sheet.locator("[data-agentation-root]").waitFor();
  await page.getByRole("button", { name: "Start feedback mode", exact: true }).click();
  await page.locator(".qt-mobile-form-field > span").first().click();
  const sheetComment = "Example feedback: simplify this Condition control.";
  const input = page.getByPlaceholder("What should change?", { exact: true });
  await input.fill(sheetComment);
  assert(await input.evaluate((element) => element.getRootNode().activeElement === element), "Sheet annotations retain focus");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const sheetFeedback = await copy();
  assert(sheetFeedback.includes(sheetComment));
  const sheetAnnotation = sheetFeedback.slice(sheetFeedback.lastIndexOf("### "));
  assert.match(sheetAnnotation, /\*\*Source:\*\* .*QueryBuilder\.tsx/);
  assert.match(sheetAnnotation, /qt-mobile-form-field/);
  assert.equal(await sheet.count(), 1, "Annotating does not close the sheet");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.getByRole("button", { name: "Close Filter by Job", exact: true }).click();
  await page.getByRole("button", { name: "Start feedback mode", exact: true }).waitFor();
  assert.equal(await sheet.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS Agentation: component/source targeting, clipboard export, persistence, desktop dialog and mobile sheet focus, and toolbar recovery");
} finally {
  await browser.close();
}
