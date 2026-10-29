// Start npm run demo first. QT_DEMO_URL can target a production preview too.
// Fitted columns must keep every native control inside its own cell; when the
// controls need more than the screen, the table scrolls instead. Asserts
// containment and usability, not pixel sizes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179/";
const screenshots = new URL("../.context/fit-controls/", import.meta.url);
await mkdir(screenshots, { recursive: true });

async function clipped(page) {
  await page.waitForTimeout(250);
  return page.locator(".qt-table-wrap td.qt-cell").evaluateAll(cells => cells.flatMap(cell => {
    const box = cell.getBoundingClientRect();
    return [...cell.querySelectorAll("a[href], button, .qt-group-link--blocked")].flatMap(control => {
      const r = control.getBoundingClientRect();
      if (!r.width) return [];
      const shown = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
      return shown + 1 < r.width ? [`${control.className} "${control.textContent.trim()}" in ${cell.dataset.qtField} (${Math.round(shown)} of ${Math.round(r.width)}px shown)`] : [];
    });
  }));
}

for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 1024, 390, 320]) {
      const where = `${engineName} ${width}px`;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(new URL("/fit-controls", origin).href);
      await page.locator("[data-table=groups] a.qt-group-link").first().waitFor();
      await page.locator("[data-table=items] .qt-json-preview--invalid").first().waitFor();
      assert.deepEqual(await clipped(page), [], `${where}: controls stay inside their cells`);

      // Shortened link labels keep their full accessible name and destination.
      const link = page.locator("[data-table=groups] a.qt-group-link", { hasText: "Matching records" }).first();
      assert.equal(await link.evaluate(a => a.textContent), "Matching records");
      assert.match(await link.getAttribute("href"), /^\/fit-controls\?items=/);

      // When the controls need more than the screen, the table scrolls to them.
      const items = page.locator("[data-table=items] .qt-table-wrap");
      const overflow = await items.evaluate(wrap => wrap.scrollWidth - wrap.clientWidth);
      if (width >= 1024) assert.ok(overflow <= 1, `${where}: fitted items fill the screen without scrolling (${overflow}px)`);
      const expand = page.getByRole("button", { name: "Expand item 1", exact: true });
      await expand.scrollIntoViewIfNeeded();
      assert.ok(await expand.evaluate(button => {
        const r = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }), `${where}: the scrolled-to Expand button is uncovered`);
      // Keyboard activation; WebKit's synthetic clicks miss icon buttons in scrolled tables.
      await expand.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[aria-label="Expand item 1"]')?.getAttribute("aria-expanded") === "true");
      assert.deepEqual(await clipped(page), [], `${where}: controls stay inside their cells with a row expanded`);
      await expand.focus();
      await page.keyboard.press("Enter");
      const modal = page.getByRole("button", { name: "Open item 2 in modal", exact: true });
      await modal.scrollIntoViewIfNeeded();
      // WebKit does not focus clicked buttons, so open from the keyboard.
      await modal.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await modal.evaluate(button => document.activeElement === button), true, `${where}: focus returns to the opener`);

      // Reopening the encoded query keeps fitting and containment.
      await page.reload();
      await page.locator("[data-table=groups] a.qt-group-link").first().waitFor();
      assert.match(new URL(page.url()).searchParams.get("groups") ?? "fitToScreen", /./);
      assert.deepEqual(await clipped(page), [], `${where}: controls stay inside their cells after reload`);
      assert.deepEqual(errors, [], `${where}: no page errors`);
      await page.screenshot({ path: new URL(`${engineName.toLowerCase()}-${width}.png`, screenshots).pathname, fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
console.log("fit-to-screen control checks passed");
