// Start npm run demo first; QT_DEMO_URL selects a different server.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { decodeQuery } from "../packages/core/dist/index.js";
const base = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const browser = await chromium.launch({ headless: true });
const errors = [];
function itemUrl(properties) {
  const url = new URL("/objects", base);
  const state = { l: 50, d: { modes: ["modal", "hover", "expand"], views: {
    hover: { version: 1, properties },
    expand: { version: 1, properties: [{ id: "tool", field: "tool_name" }, { id: "command", field: "command" }] },
  } } };
  url.searchParams.set("q", Buffer.from(JSON.stringify(state)).toString("base64url"));
  return url.href;
}
async function assertPopoverFits(page, popup) {
  await page.waitForFunction(() => {
    const root = document.querySelector(".qt-item-hover-card");
    const box = root?.getBoundingClientRect();
    return box && box.top >= 12 && box.left >= 12 && box.bottom <= innerHeight - 11 && box.right <= innerWidth - 11;
  });
  assert.equal(await popup.locator(".qt-item-hover-tools, .qt-item-detail-footer, .qt-property-scope").count(), 0);
  const geometry = await popup.evaluate((root) => {
    const card = root.querySelector(":scope > .qt-object-inspector");
    const footer = card.querySelector(".qt-object-footer");
    const properties = card.querySelector(".qt-object-properties");
    return { padding: getComputedStyle(root).padding, rootBottom: root.getBoundingClientRect().bottom,
      cardBottom: card.getBoundingClientRect().bottom, footerBottom: footer.getBoundingClientRect().bottom,
      scrollHeight: properties.scrollHeight, clientHeight: properties.clientHeight };
  });
  assert.equal(geometry.padding, "0px");
  assert.ok(Math.abs(geometry.cardBottom - geometry.rootBottom) <= 1);
  assert.ok(Math.abs(geometry.footerBottom - geometry.cardBottom) <= 1);
  return geometry;
}
try {
  await mkdir(".context", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(itemUrl([{ id: "tool", field: "tool_name" }]));
  const preview = page.getByRole("button", { name: "Preview item call-1", exact: true });
  await preview.click();
  const popup = page.getByRole("dialog", { name: "Item preview", exact: true });
  await popup.locator("dt").first().waitFor();
  await assertPopoverFits(page, popup);
  assert.ok((await popup.boundingBox()).height < 200);
  const anchor = await preview.boundingBox(), bounds = await popup.boundingBox();
  assert.ok(Math.abs(bounds.y - anchor.y - anchor.height - 8) <= 1, "Short preview sits beside its trigger");
  await popup.getByRole("button", { name: "Close item preview", exact: true }).click();
  assert.equal(await preview.evaluate((button) => button === document.activeElement), true);

  const longView = Array.from({ length: 40 }, (_, i) => ({ id: `property-${i}`, field: i === 39 ? "workspace_id" : "tool_name" }));
  await page.goto(itemUrl(longView));
  await preview.click();
  await popup.locator("dt").last().waitFor();
  let geometry = await assertPopoverFits(page, popup);
  assert.ok(geometry.scrollHeight > geometry.clientHeight);
  const properties = popup.locator(".qt-object-properties");
  await properties.evaluate((root) => { root.scrollTop = root.scrollHeight; });
  const last = await properties.locator(".qt-property").last().boundingBox();
  const scrollBounds = await properties.boundingBox();
  assert.ok(last.y + last.height <= scrollBounds.y + scrollBounds.height + 1);
  await popup.getByRole("button", { name: "Share", exact: true }).click();
  const shared = decodeQuery(new URL(await page.evaluate(() => navigator.clipboard.readText())).searchParams.get("q"));
  assert.equal(shared.itemDetails.views.modal.properties.length, 40);
  await page.screenshot({ path: ".context/item-popover-refined.png" });
  await page.setViewportSize({ width: 390, height: 660 });
  geometry = await assertPopoverFits(page, popup);
  assert.ok(geometry.clientHeight > 0 && geometry.scrollHeight > geometry.clientHeight);
  await popup.getByRole("button", { name: "Customize properties", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit properties", exact: true });
  await editor.waitFor();
  assert.match(await editor.innerText(), /Popover only/);
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  await popup.waitFor();
  assert.equal(await popup.getByRole("button", { name: "Customize properties", exact: true }).evaluate((button) => button === document.activeElement), true);
  await page.screenshot({ path: ".context/item-popover-refined-mobile.png" });
  await popup.getByRole("button", { name: "Open in modal", exact: true }).click();
  await popup.waitFor({ state: "detached" });
  const modal = page.getByRole("dialog", { name: "Item details", exact: true });
  await modal.locator("dt").first().waitFor();
  assert.equal(await modal.locator("dt").count(), 10, "Opening the modal keeps its independent view");
  await modal.getByRole("button", { name: "Close item details", exact: true }).click();

  await page.setViewportSize({ width: 1440, height: 800 });
  await page.getByRole("button", { name: "Expand item call-1", exact: true }).click();
  const expanded = page.getByRole("region", { name: "Expanded item call-1", exact: true });
  await expanded.locator("dt").first().waitFor();
  assert.deepEqual(await expanded.locator("dt").allTextContents(), ["Tool", "Command"]);
  assert.equal(await expanded.locator(".qt-item-detail-footer, .qt-property-scope").count(), 0);
  await expanded.locator(".qt-property-controls").getByRole("button", { name: "Collapse item call-1", exact: true }).waitFor();
  await page.screenshot({ path: ".context/item-expanded-refined.png" });
  await expanded.getByRole("button", { name: "Open in modal", exact: true }).click();
  await expanded.waitFor({ state: "detached" });
  await modal.locator("dt").first().waitFor();
  await modal.getByRole("button", { name: "Close item details", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("PASS: compact flush popover, short-content anchoring, long/mobile scrolling, toolbar sharing/modal/close, nested editor focus, independent modality views, streamlined expanded row.");
} finally { await browser.close(); }
