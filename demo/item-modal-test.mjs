// Start npm run demo first; QT_DEMO_URL selects a different server.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const browser = await chromium.launch({ headless: true });
const errors = [];
const dialog = (page) => page.getByRole("dialog", { name: "Item details", exact: true });
function itemUrl(properties, id = "call-1") {
  const url = new URL("/objects", base);
  const state = { l: 50, d: { modes: ["modal"], active: { id, mode: "modal" } } };
  if (properties) state.d.views = { modal: { version: 1, properties } };
  url.searchParams.set("q", Buffer.from(JSON.stringify(state)).toString("base64url"));
  return url.href;
}
async function assertFlush(modal, mobile = false) {
  await modal.evaluate(async (root) => { await Promise.all(root.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
  assert.equal(await modal.locator(":scope > .qt-overlay-header, :scope > .qt-overlay-body, :scope > .qt-item-detail-footer").count(), 0);
  assert.equal(await modal.getByRole("button", { name: "Done", exact: true }).count(), 0);
  assert.equal(await modal.locator(".qt-property-toolbar .qt-property-scope").count(), 0);
  await modal.locator(".qt-property-close-divider").waitFor();
  const geometry = await modal.evaluate((root) => {
    const card = root.querySelector(":scope > .qt-object-inspector");
    const footer = card.querySelector(".qt-object-footer");
    const reset = card.querySelector('[aria-label="Reset properties"]');
    const close = card.querySelector('[aria-label="Close item details"]');
    const box = (element) => {
      const { top, bottom, left, right, height } = element.getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    return { paddingBottom: parseFloat(getComputedStyle(root).paddingBottom), root: box(root), card: box(card), footer: box(footer), reset: box(reset), close: box(close) };
  });
  assert.equal(geometry.paddingBottom, 0, "Feedback must not reserve empty space beneath the card");
  assert.ok(Math.abs(geometry.card.bottom - geometry.root.bottom) <= 1);
  assert.ok(Math.abs(geometry.card.left - geometry.root.left) <= 1);
  assert.ok(Math.abs(geometry.card.right - geometry.root.right) <= 1);
  assert.ok(Math.abs(geometry.footer.bottom - geometry.card.bottom) <= 1);
  assert.ok(Math.abs(geometry.close.top - geometry.reset.top) <= 1, "Close stays alongside Reset");
  assert.ok(geometry.close.left >= geometry.reset.right);
  assert.ok(geometry.close.left - geometry.reset.right < 16);
  if (!mobile) assert.ok(Math.abs(geometry.card.top - geometry.root.top) <= 1);
  assert.ok(geometry.root.top >= 0 && geometry.root.bottom <= await modal.page().evaluate(() => innerHeight));
}
async function assertLastPropertyReachable(modal) {
  const properties = modal.locator(":scope > .qt-object-inspector > .qt-object-properties");
  assert.ok(await properties.evaluate((root) => root.scrollHeight > root.clientHeight));
  await properties.evaluate((root) => { root.scrollTop = root.scrollHeight; });
  const bounds = await properties.boundingBox();
  const last = await properties.locator(".qt-property").last().boundingBox();
  assert.ok(last.y >= bounds.y && last.y + last.height <= bounds.y + bounds.height + 1);
  await modal.getByRole("button", { name: "Close item details", exact: true }).waitFor({ state: "visible" });
}
try {
  await mkdir(".context", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL("/objects", base).href);
  const trigger = page.getByRole("button", { name: "Open item call-1 in modal", exact: true });
  await page.getByRole("button", { name: "Expand query builder", exact: true }).click();
  const detailArrow = page.getByRole("button", { name: "Configure Detail column", exact: true });
  assert.equal(await detailArrow.locator('[data-icon="chevronRight"]').count(), 1);
  await detailArrow.focus();
  await detailArrow.press("Enter");
  let columns = page.getByRole("dialog", { name: "Select columns", exact: true });
  await columns.getByRole("checkbox", { name: "Include Modal", exact: true }).waitFor();
  assert.equal(await columns.getByRole("checkbox", { name: "Include Modal", exact: true }).isChecked(), true);
  await columns.getByRole("checkbox", { name: "Include Popover", exact: true }).check();
  await page.screenshot({ path: ".context/detail-chip-settings.png" });
  await columns.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
  assert.equal(await detailArrow.evaluate((button) => button === document.activeElement), true);
  assert.equal(await page.getByRole("button", { name: "Preview item call-1", exact: true }).count(), 0);
  // The generic selector still opens at the first column after a Detail shortcut.
  await page.getByRole("button", { name: "Customize columns", exact: true }).click();
  columns = page.getByRole("dialog", { name: "Select columns", exact: true });
  assert.equal(await columns.getByRole("checkbox", { name: "Include Modal", exact: true }).count(), 0);
  await columns.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
  await page.getByRole("button", { name: "Collapse query builder", exact: true }).click();
  await trigger.click();
  let modal = dialog(page);
  await modal.locator("dt").first().waitFor();
  // Wait for the demo feedback portal too: its old selector added 72px below this card.
  await modal.locator(".qt-demo-feedback").waitFor({ state: "attached" });
  await assertFlush(modal);
  await page.screenshot({ path: ".context/item-modal-flush.png" });

  // A resized dialog keeps controls/footer fixed and gives the remaining height to rows.
  await modal.evaluate((root) => { root.style.height = "300px"; });
  await assertFlush(modal);
  await assertLastPropertyReachable(modal);
  await modal.getByRole("button", { name: "Customize properties", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit properties", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await modal.count(), 1);
  assert.equal(await modal.getByRole("button", { name: "Customize properties", exact: true }).evaluate((button) => button === document.activeElement), true);
  await modal.getByRole("button", { name: "Close item details", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate((button) => button === document.activeElement), true);

  // Small and empty saved views fit their content without a reserved minimum-height gap.
  for (const properties of [[{ id: "tool", field: "tool_name" }], []]) {
    await page.goto(itemUrl(properties));
    modal = dialog(page);
    await modal.locator(".qt-object-footer").waitFor();
    await assertFlush(modal);
    const height = (await modal.boundingBox()).height;
    assert.ok(height < 180, `Small view should size to content, got ${height}px`);
  }
  await page.goto(itemUrl(undefined, "missing-item"));
  modal = dialog(page);
  await modal.getByRole("status").filter({ hasText: "unavailable" }).waitFor();
  await modal.getByRole("button", { name: "Share", exact: true }).waitFor();
  await modal.getByRole("button", { name: "Close item details", exact: true }).click();
  await modal.waitFor({ state: "detached" });

  // A long saved view must scroll all the way to its final property on a phone.
  await page.setViewportSize({ width: 390, height: 660 });
  const longView = Array.from({ length: 40 }, (_, i) => ({ id: `property-${i}`, field: i === 39 ? "workspace_id" : "tool_name" }));
  await page.goto(itemUrl(longView));
  modal = dialog(page);
  await modal.locator("dt").last().waitFor();
  await assertFlush(modal, true);
  await assertLastPropertyReachable(modal);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: ".context/item-modal-flush-mobile.png" });
  await modal.getByRole("button", { name: "Close item details", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Expand query builder", exact: true }).click();
  await detailArrow.click();
  columns = page.getByRole("dialog", { name: "Select columns", exact: true });
  await columns.getByRole("checkbox", { name: "Include Modal", exact: true }).waitFor();
  assert.equal(await columns.locator(".qt-column-workbench").isVisible(), true);
  assert.equal(await columns.getByRole("button", { name: "Preview", exact: true }).getAttribute("aria-pressed"), "true");
  await columns.evaluate(async (root) => { await Promise.all(root.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: ".context/detail-chip-settings-mobile.png" });
  await columns.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
  assert.equal(await detailArrow.evaluate((button) => button === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log("PASS: flush item modal, separated Close, no Modal label, Detail chip shortcut and transactional settings on desktop/mobile, fixed controls/footer, scrollable long/resized views, compact short/empty views, unavailable state, nested Escape and focus restoration.");
} finally { await browser.close(); }
