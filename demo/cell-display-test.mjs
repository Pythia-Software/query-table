// Start npm run demo first. QT_BROWSER_CHANNEL=chrome uses installed Chrome.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({ headless: true, ...(process.env.QT_BROWSER_CHANNEL ? { channel: process.env.QT_BROWSER_CHANNEL } : {}) });
await mkdir(".context", { recursive: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.QT_DEMO_URL || "http://127.0.0.1:5179/");
    const section = page.getByRole("region", { name: "Cell displays", exact: true });
    await section.scrollIntoViewIfNeeded();
    await section.getByRole("button", { name: "Inspect Payload", exact: true }).first().waitFor();
    assert.equal(await section.getByRole("button", { name: "Inspect Payload", exact: true }).count(), 6);
    assert.equal(await section.locator('.qt-cell[data-qt-field="elapsed"]').first().innerText(), "00:01:01.250");
    for (let i = 0; i < 5; i++) {
      const trigger = section.getByRole("button", { name: "Inspect Payload", exact: true }).nth(i);
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Payload · JSON", exact: true });
      await dialog.waitFor();
      assert.equal(await page.locator(".qt-cell-menu").count(), 0);
      await dialog.getByRole("searchbox").fill("42");
      assert.ok((await dialog.locator(".qt-json-entry").count()) > 0);
      assert.match(await dialog.innerText(), /matching paths/);
      await dialog.getByRole("button", { name: "Copy original", exact: true }).click();
      const original = await page.evaluate(() => navigator.clipboard.readText());
      if (i === 2) assert.equal(typeof JSON.parse(original), "string");
      if (i === 3) assert.match(original, /\\"customer\\"/);
      await dialog.getByRole("button", { name: "Copy JSON", exact: true }).click();
      const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      assert.equal(i === 4 ? json[0].id : json.customer.id, 42);
      if (i === 0) {
        await dialog.getByRole("searchbox").fill("customer");
        await page.screenshot({ path: `.context/json-inspector-${mobile ? "mobile" : "desktop"}.png` });
      }
      await dialog.getByRole("button", { name: "Close Payload · JSON", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    }
    await section.getByRole("button", { name: "Inspect Payload", exact: true }).nth(5).click();
    const invalid = page.getByRole("dialog", { name: "Payload · JSON", exact: true });
    assert.match(await invalid.getByRole("alert").innerText(), /Invalid JSON/);
    assert.equal(await invalid.getByRole("button", { name: "Copy JSON", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `.context/cell-displays-${mobile ? "mobile" : "desktop"}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Cell displays: desktop/mobile JSON decoding, search, copy, dismissal and formatting passed.");
} finally { await browser.close(); }
