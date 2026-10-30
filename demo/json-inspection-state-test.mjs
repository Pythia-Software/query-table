// Start the demo first. Each restore uses an empty browser context.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({ headless: true, ...(process.env.QT_BROWSER_CHANNEL ? { channel: process.env.QT_BROWSER_CHANNEL } : {}) });
const base = process.env.QT_DEMO_URL || "http://localhost:5179/cells";
await mkdir(".context", { recursive: true });
let restores = 0;
async function published(page, change) {
  const previous = page.url();
  await change();
  // The input can render before the URL effect publishes its query snapshot.
  await page.waitForURL(url => url.toString() !== previous);
}
async function restore(page, verify) {
  const url = page.url();
  assert.ok(new URL(url).searchParams.get("q")?.startsWith("2"), "Fixture must fit a portable inline URL");
  const fresh = await browser.newContext();
  const restored = await fresh.newPage();
  try { await restored.goto(url); await verify(restored); restores++; } finally { await fresh.close(); }
}
const viewer = page => page.getByRole("dialog", { name: "Payload · JSON", exact: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await published(page, () => page.getByRole("button", { name: "Expand item 6", exact: true }).click());
  await published(page, () => page.getByRole("button", { name: "Open Payload in JSON Viewer", exact: true }).click());
  const search = viewer(page).getByRole("searchbox", { name: "Search Payload JSON" });
  await published(page, () => search.fill("Ada"));
  await restore(page, async fresh => {
    await viewer(fresh).waitFor();
    assert.equal(await viewer(fresh).getByRole("searchbox").inputValue(), "Ada");
    assert.equal(await viewer(fresh).getByRole("combobox").inputValue(), "filter");
    assert.equal(await viewer(fresh).locator(".qt-json-search-count").innerText(), "1/4");
  });
  await published(page, () => viewer(page).getByRole("combobox", { name: "JSON search mode" }).selectOption("find"));
  await published(page, () => viewer(page).getByRole("button", { name: "Next JSON match", exact: true }).click());
  await published(page, () => viewer(page).getByRole("button", { name: "Expand $ items 40–59", exact: true }).click());
  await restore(page, async fresh => {
    await viewer(fresh).waitFor();
    assert.equal(await viewer(fresh).getByRole("searchbox").inputValue(), "Ada");
    assert.equal(await viewer(fresh).getByRole("combobox").inputValue(), "find");
    assert.equal(await viewer(fresh).locator(".qt-json-current-mark").innerText(), "Ada");
    assert.equal(await viewer(fresh).locator(".qt-json-search-count").innerText(), "2/4");
    await viewer(fresh).getByRole("button", { name: "Collapse $ items 40–59", exact: true }).waitFor();
  });
  await published(page, () => viewer(page).getByRole("button", { name: "Show original", exact: true }).click());
  await restore(page, async fresh => {
    await viewer(fresh).locator(".qt-json-original").waitFor();
    assert.equal(await viewer(fresh).getByRole("searchbox").inputValue(), "Ada");
  });
  await published(page, () => viewer(page).getByRole("button", { name: "Show JSON", exact: true }).click());
  await published(page, () => search.fill(""));
  await published(page, () => viewer(page).getByRole("button", { name: "Expand $", exact: true }).click());
  for (const range of ["20–39", "40–59", "60–64"]) await published(page, () => viewer(page).getByRole("button", { name: `Expand $ items ${range}`, exact: true }).click());
  let paged = false;
  for (let index = 0; index < 65; index++) {
    const expand = viewer(page).getByRole("button", { name: `Expand $[${index}]`, exact: true });
    if (!await expand.count()) { await published(page, () => viewer(page).getByRole("button", { name: "Show more", exact: true }).click()); paged = true; }
    await published(page, () => expand.click());
  }
  assert.ok(paged, "The UI changed the visible-entry limit");
  await published(page, () => viewer(page).getByRole("button", { name: "Collapse $[0]", exact: true }).click());
  await restore(page, async fresh => {
    await viewer(fresh).getByRole("button", { name: "Expand $[0]", exact: true }).waitFor();
    await viewer(fresh).getByRole("button", { name: "Collapse $ items 40–59", exact: true }).waitFor();
    await viewer(fresh).getByRole("button", { name: "Collapse $[64]", exact: true }).waitFor();
    assert.equal(await viewer(fresh).getByRole("searchbox").inputValue(), "");
    assert.equal(await viewer(fresh).getByRole("button", { name: "Show more", exact: true }).count(), 0);
    await fresh.screenshot({ path: ".context/json-inspection-restored.png", fullPage: false });
  });
  await published(page, () => viewer(page).getByRole("button", { name: "Close Payload · JSON", exact: true }).click());
  await restore(page, async fresh => {
    await fresh.getByRole("button", { name: "Open Payload in JSON Viewer", exact: true }).waitFor();
    assert.equal(await viewer(fresh).count(), 0);
    await fresh.getByRole("button", { name: "Open Payload in JSON Viewer", exact: true }).click();
    await viewer(fresh).getByRole("button", { name: "Expand $[0]", exact: true }).waitFor();
    await viewer(fresh).getByRole("button", { name: "Collapse $[64]", exact: true }).waitFor();
  });
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`JSON inspection: ${restores} fresh-browser restores passed`);
} finally { await browser.close(); }
