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
    await page.goto(process.env.QT_DEMO_URL || "http://localhost:5179/cells");
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
      assert.equal(await dialog.locator(".qt-overlay-header").count(), 0);
      const geometry = await dialog.evaluate(root => {
        const search = root.querySelector('.qt-json-search').getBoundingClientRect();
        const toolbar = root.querySelector('.qt-json-toolbar').getBoundingClientRect();
        const actions = root.querySelector('.qt-json-actions').getBoundingClientRect();
        const footer = root.querySelector('.qt-json-footer').getBoundingClientRect();
        return { padding: parseFloat(getComputedStyle(root).paddingBottom), searchLeft: search.left, actionsRight: actions.right,
          searchTop: search.top, searchBottom: search.bottom, toolbarTop: toolbar.top, toolbarBottom: toolbar.bottom,
          footerBottom: footer.bottom, bottom: root.getBoundingClientRect().bottom };
      });
      assert.equal(geometry.padding, 0);
      assert.ok(geometry.searchLeft >= geometry.actionsRight, "Search stays at the right of the toolbar");
      assert.ok(geometry.searchTop >= geometry.toolbarTop && geometry.searchBottom <= geometry.toolbarBottom);
      assert.ok(Math.abs(geometry.footerBottom - geometry.bottom) <= 1, "The footer is flush with the modal");
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
        await page.screenshot({ path: `.context/json-inspector-search-${mobile ? "mobile" : "desktop"}.png` });
        await dialog.getByRole("searchbox").fill("");
        await dialog.getByRole("button", { name: 'Expand $["customer"]', exact: true }).click();
        await dialog.getByRole("button", { name: 'Expand $["tags"]', exact: true }).click();
        const pretty = (await dialog.locator('.qt-json-line-code').allTextContents()).join("\n");
        assert.equal(JSON.parse(pretty).customer.name, "Ada");
        await dialog.getByRole("button", { name: 'Copy value at $["customer"]', exact: true }).click();
        assert.deepEqual(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())), json.customer);
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
    await section.getByRole("button", { name: "Expand item 1", exact: true }).click();
    const expanded = section.getByRole("region", { name: "Expanded item 1", exact: true });
    await expanded.getByRole("searchbox", { name: "Search Payload JSON" }).fill("ada");
    assert.equal(await expanded.locator(".qt-json-match").count(), 2); // name and email
    assert.equal(await page.getByRole("dialog").count(), 0);
    await expanded.getByRole("button", { name: "Collapse item 1", exact: true }).click();

    await section.getByRole("button", { name: "Preview item 2", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Item preview", exact: true });
    await popover.getByRole("searchbox", { name: "Search Payload JSON" }).fill("ada");
    assert.equal(await popover.locator(".qt-json-match").count(), 2);
    assert.equal(await page.getByRole("dialog").count(), 1);
    await popover.getByRole("button", { name: "Close item preview", exact: true }).click();

    await section.getByRole("button", { name: "Open item 3 in modal", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Item details", exact: true });
    await details.getByRole("searchbox", { name: "Search Payload JSON" }).fill("ada");
    assert.equal(await details.locator(".qt-json-match").count(), 2);
    assert.equal(await details.getByRole("button", { name: "Inspect Payload", exact: true }).count(), 0);
    await details.getByRole("button", { name: "Copy JSON", exact: true }).click();
    assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).customer.name, "Ada");
    await page.screenshot({ path: `.context/json-item-details-${mobile ? "mobile" : "desktop"}.png` });
    await details.getByRole("button", { name: "Customize properties", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit properties", exact: true });
    await editor.locator(".qt-property-pick").filter({ hasText: "Payload" }).click();
    await editor.locator('select[aria-label^="Display for"]').selectOption("json");
    await editor.locator('select[aria-label^="JSON input for"]').selectOption("value");
    await editor.locator('input[aria-label^="JSON decode passes for"]').fill("6");
    await editor.getByRole("button", { name: "Apply properties", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal(await details.locator(".qt-json-value--string").count(), 1);
    await details.getByRole("button", { name: "Share", exact: true }).click();
    const shared = await page.evaluate(() => navigator.clipboard.readText());
    await page.goto(shared);
    const restored = page.getByRole("dialog", { name: "Item details", exact: true });
    await restored.locator(".qt-json-value--string").waitFor();
    assert.equal(await restored.locator(".qt-json-entry").count(), 1);
    await restored.getByRole("button", { name: "Close item details", exact: true }).click();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Cell displays: desktop/mobile decoding, copy, inline item details, view editing and shared restoration passed.");
} finally { await browser.close(); }
