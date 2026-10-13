// The shared mobile query includes short coarse-pointer viewports wider than 760px.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
await mkdir(".context/grouping-landscape", { recursive: true });
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(new URL("/grouping", origin).toString());
    await page.getByRole("button", { name: "Duration by platform", exact: true }).click();
    await page.getByRole("columnheader", { name: /Row count/ }).waitFor();
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse) and (max-height: 500px)").matches), true);
    await page.getByRole("button", { name: "Customize columns", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Select columns", exact: true });
    const nav = editor.getByRole("navigation", { name: "Column editor sections" });
    assert.equal(await nav.isVisible(), true, `${name}: landscape navigation is visible`);
    assert.equal(await editor.locator('.qt-column-panel-tools').isVisible(), false);
    assert.equal(await editor.locator('.qt-columns-workspace').evaluate(el => el.style.gridTemplateColumns), "");
    const panes = [".qt-columns-library", ".qt-columns-definition", ".qt-columns-functions", ".qt-columns-preview"];
    for (const [index, label] of ["Columns (4)", "Column", "Functions", "Preview"].entries()) {
      await nav.getByRole("button", { name: label, exact: true }).click();
      for (const [i, selector] of panes.entries()) assert.equal(await editor.locator(selector).isVisible(), i === index, `${name}: ${label} pane selection`);
      const box = await editor.boundingBox();
      assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= 845 && box.y + box.height <= 391, `${name}: landscape editor fits`);
    }
    await page.screenshot({ path: `.context/grouping-landscape/${name}.png` });
    await page.getByRole("button", { name: "Close column editor", exact: true }).click();
    await page.getByRole("button", { name: "Add representative row", exact: true }).click();
    await page.locator(".qt-picker-item").filter({ has: page.locator(".qt-picker-label", { hasText: /^Duration$/ }) }).click();
    const representative = page.getByRole("dialog", { name: "Representative row", exact: true });
    assert.equal(await representative.getByRole("button", { name: "Close representative editor" }).isVisible(), true);
    await representative.getByRole("button", { name: "Apply ordering" }).click();
    await page.getByRole("button", { name: "Edit representative row" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`${name}: landscape grouping panels, navigation, viewport bounds, and representative ordering passed.`);
  } catch (error) {
    await page.screenshot({ path: `.context/grouping-landscape/${name}-failure.png` });
    throw error;
  } finally { await browser.close(); }
}
