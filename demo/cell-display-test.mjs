// Start npm run demo first. QT_BROWSER_CHANNEL=chrome uses installed Chrome.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
/** SelectColumn.display clamps long text; measured virtual rows must tile
 * exactly (no overlaps or gaps) while scrolling and after a column resize. */
async function verifyReadingLayout(page, mobile) {
  const layout = page.getByRole("region", { name: "Reading layout", exact: true });
  await layout.scrollIntoViewIfNeeded();
  const commands = layout.locator('.qt-cell[data-qt-field="command"] .qt-line-clamp');
  await commands.first().waitFor();
  const clamp = await commands.first().evaluate(el => ({ clamp: getComputedStyle(el).webkitLineClamp, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 16, height: el.getBoundingClientRect().height, scroll: el.scrollHeight }));
  assert.equal(clamp.clamp, "3");
  const wrap = layout.locator(".qt-table-wrap");
  const rowsTile = async () => wrap.evaluate(root => {
    const rows = [...root.querySelectorAll("tbody tr.qt-row")].map(row => row.getBoundingClientRect());
    return { count: rows.length, gaps: rows.slice(1).map((r, i) => Math.round((r.top - rows[i].bottom) * 10) / 10).filter(gap => Math.abs(gap) > 1), heights: [...new Set(rows.map(r => Math.round(r.height)))] };
  });
  let tiling = await rowsTile();
  assert.ok(tiling.count > 0 && tiling.count < 100, "Rows stay virtualized");
  assert.deepEqual(tiling.gaps, [], "Clamped rows tile without overlaps or gaps");
  assert.ok(tiling.heights.length > 1, "Clamped rows have measured, varying heights");
  await wrap.evaluate(root => { root.scrollTop = (root.scrollHeight - root.clientHeight) / 2; });
  await page.waitForTimeout(150);
  tiling = await rowsTile();
  assert.deepEqual(tiling.gaps, [], "Rows tile after scrolling to the middle");
  // Measured rows replace the 37px estimate, so the total grows while
  // scrolling. Keep scrolling to the end until the size settles.
  for (let previous = -1, i = 0; i < 20; i++) {
    const top = await wrap.evaluate(root => { root.scrollTop = root.scrollHeight; return root.scrollTop; });
    await page.waitForTimeout(100);
    if (top === previous) break;
    previous = top;
  }
  tiling = await rowsTile();
  assert.deepEqual(tiling.gaps, [], "Rows tile at the end");
  const last = await wrap.evaluate(root => {
    const row = [...root.querySelectorAll("tbody tr.qt-row")].at(-1);
    const bounds = root.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { text: row.querySelector('[data-qt-field="name"]').textContent, inside: r.bottom <= bounds.bottom + 1 };
  });
  assert.equal(last.text, "Run 400", "The final measured row is reachable");
  assert.ok(last.inside, "The final row is fully visible at the bottom");
  if (!mobile) {
    // Narrowing a clamped column reflows every row; measurements must follow.
    const before = await commands.last().evaluate(el => el.closest("tr").getBoundingClientRect().height);
    await layout.getByRole("separator", { name: "Resize Command column", exact: true }).focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(150);
    tiling = await rowsTile();
    assert.deepEqual(tiling.gaps, [], "Rows tile after resizing a clamped column");
    assert.ok(await commands.count() > 0, "Writing a width keeps the column's display override");
    const after = await commands.last().evaluate(el => el.closest("tr").getBoundingClientRect().height);
    assert.ok(after >= before, "Narrower clamped cells re-measure to equal or taller rows");
  }
  await layout.screenshot({ path: `.context/cell-display-clamp-${mobile ? "mobile" : "desktop"}.png` });
}

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
    assert.equal(await section.getByRole("button", { name: "Inspect Payload", exact: true }).count(), 7);
    assert.equal(await section.locator('.qt-cell[data-qt-field="elapsed"]').first().innerText(), "00:01:01.250");
    const payloadCell = section.locator('.qt-cell[data-qt-field="payload"]').first();
    const preview = payloadCell.locator(".qt-json-preview-text");
    await preview.click();
    const cellMenu = page.getByRole("menu", { name: "Payload", exact: true });
    await cellMenu.waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Payload · JSON", exact: true }).count(), 0);
    await cellMenu.getByRole("menuitem", { name: "copy value", exact: true }).click();
    const rawPayload = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(JSON.parse(rawPayload).customer.name, "Ada");
    await preview.click();
    await cellMenu.getByRole("menuitem", { name: "Open in JSON Viewer", exact: true }).click();
    const menuViewer = page.getByRole("dialog", { name: "Payload · JSON", exact: true });
    await menuViewer.waitFor();
    assert.equal(await page.locator(".qt-cell-menu").count(), 0);
    assert.equal(await menuViewer.getByRole("button", { name: "Collapse $", exact: true }).count(), 1);
    await menuViewer.getByRole("button", { name: "Close Payload · JSON", exact: true }).click();
    assert.equal(await payloadCell.evaluate(cell => cell === document.activeElement), true);
    // A mobile tap opens a sheet over the cell; verify the desktop dblclick
    // handler directly there, while desktop exercises the native mouse gesture.
    if (mobile) await preview.dispatchEvent("dblclick"); else await preview.dblclick();
    await payloadCell.locator(".qt-cell-copy-chip").waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), rawPayload);
    assert.equal(await page.locator(".qt-cell-menu").count(), 0);
    assert.equal(await page.getByRole("dialog", { name: "Payload · JSON", exact: true }).count(), 0);
    await payloadCell.getByRole("button", { name: "Inspect Payload", exact: true }).waitFor();
    await section.locator('.qt-cell[data-qt-field="elapsed"]').first().click();
    assert.equal(await page.getByRole("menuitem", { name: "Open in JSON Viewer", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
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
      // The 1px border plus sub-pixel sheet offsets (e.g. 1.00003px) on mobile.
      assert.ok(Math.abs(geometry.footerBottom - geometry.bottom) < 1.5, "The footer is flush with the modal " + JSON.stringify({ mobile, i, ...geometry }));
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
        assert.equal(await dialog.getByRole("button", { name: "Collapse $", exact: true }).getAttribute("aria-expanded"), "true");
        assert.equal(await dialog.getByRole("button", { name: 'Collapse $["customer"]', exact: true }).getAttribute("aria-expanded"), "true");
        assert.equal(await dialog.getByRole("button", { name: 'Collapse $["tags"]', exact: true }).getAttribute("aria-expanded"), "true");
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
    await section.getByRole("button", { name: "Inspect Payload", exact: true }).nth(6).click();
    const long = page.getByRole("dialog", { name: "Payload · JSON", exact: true });
    assert.equal(await long.getByRole("button", { name: "Collapse $", exact: true }).getAttribute("aria-expanded"), "true");
    assert.equal(await long.getByRole("button", { name: "Copy value at $[19]", exact: true }).count(), 1);
    assert.equal(await long.getByRole("button", { name: "Copy value at $[20]", exact: true }).count(), 0);
    await long.getByRole("button", { name: "Expand $ items 20–39", exact: true }).click();
    assert.equal(await long.getByRole("button", { name: "Copy value at $[20]", exact: true }).count(), 1);
    assert.equal(await long.getByRole("button", { name: "Copy value at $[40]", exact: true }).count(), 0);
    await long.getByRole("button", { name: "Copy JSON", exact: true }).click();
    assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).length, 65);
    await long.getByRole("searchbox").fill("ada");
    assert.equal(await long.getByRole("button", { name: "Copy value at $[0]", exact: true }).count(), 0, "Filter hides unrelated rows");
    assert.equal(await long.locator(".qt-json-search-count").innerText(), "1/4");
    await long.getByLabel("JSON search mode").selectOption("find");
    assert.equal(await long.getByRole("button", { name: "Copy value at $[0]", exact: true }).count(), 1, "Find keeps surrounding content");
    await long.getByRole("button", { name: "Next JSON match", exact: true }).click();
    assert.equal(await long.locator(".qt-json-search-count").innerText(), "2/4");
    await long.getByRole("button", { name: "Next JSON match", exact: true }).click();
    assert.equal(await long.locator(".qt-json-search-count").innerText(), "3/4");
    assert.equal(await long.getByRole("button", { name: "Collapse $ items 60–64", exact: true }).count(), 1);
    assert.equal(await long.locator('.qt-json-match--active').getAttribute("data-json-path"), '$[61]["name"]');
    const matchVisible = await long.locator(".qt-json-current-mark").evaluate(mark => {
      const target = mark.getBoundingClientRect();
      const bounds = mark.closest('.qt-json-content').getBoundingClientRect();
      return target.top >= bounds.top && target.bottom <= bounds.bottom;
    });
    assert.ok(matchVisible, "Selected occurrence scrolls into view");
    await long.locator(".qt-json-content").evaluate(content => { content.scrollTop = 0; });
    await long.getByRole("button", { name: "Collapse $[0]", exact: true }).click();
    assert.equal(await long.locator(".qt-json-content").evaluate(content => content.scrollTop), 0, "Toggling another node preserves manual scrolling during search");
    await long.getByRole("button", { name: "Previous JSON match", exact: true }).click();
    assert.equal(await long.locator(".qt-json-search-count").innerText(), "2/4");
    await long.getByRole("searchbox").press("Shift+Enter");
    await long.getByRole("searchbox").press("Shift+Enter");
    assert.equal(await long.locator(".qt-json-search-count").innerText(), "4/4", "Previous match wraps");
    await page.screenshot({ path: `.context/json-highlight-buckets-${mobile ? "mobile" : "desktop"}.png` });
    await long.getByRole("searchbox").fill("");
    assert.equal(await long.getByRole("button", { name: "Expand $ items 60–64", exact: true }).count(), 1, "Clearing search restores collapsed buckets");
    assert.equal(await long.getByRole("button", { name: "Collapse $ items 20–39", exact: true }).count(), 1, "Clearing search preserves manually opened buckets");
    await long.getByRole("button", { name: "Close Payload · JSON", exact: true }).click();
    await page.screenshot({ path: `.context/cell-displays-${mobile ? "mobile" : "desktop"}.png` });
    const verifyCompact = async surface => {
      const property = surface.locator(".qt-property").filter({ has: page.locator("dt", { hasText: /^Payload$/ }) });
      const tree = property.locator(".qt-json-inline");
      await tree.waitFor();
      assert.equal(await tree.locator(".qt-json-entry").count(), 1);
      assert.equal(await tree.getByRole("button", { name: "Expand $", exact: true }).count(), 1);
      assert.match(await tree.innerText(), /6 keys hidden/);
      assert.equal(await tree.getByRole("searchbox").count(), 0);
      assert.equal(await tree.locator(".qt-json-toolbar, .qt-json-footer, .qt-json-copy").count(), 0);
      const style = await tree.locator(".qt-json-content").evaluate(content => ({ maxHeight: getComputedStyle(content).maxHeight, overflow: getComputedStyle(content).overflow, border: getComputedStyle(content.parentElement.parentElement).borderWidth }));
      assert.equal(style.maxHeight, "none");
      assert.equal(style.overflow, "visible");
      assert.equal(style.border, "0px");
      await tree.getByRole("button", { name: "Expand $", exact: true }).click();
      assert.equal(await tree.getByRole("button", { name: 'Expand $["customer"]', exact: true }).count(), 1);
      const open = property.locator("dt").getByRole("button", { name: "Open Payload in JSON Viewer", exact: true });
      assert.equal(await property.locator("dd").getByRole("button", { name: "Open Payload in JSON Viewer", exact: true }).count(), 0);
      await open.click();
      const viewer = page.getByRole("dialog", { name: "Payload · JSON", exact: true });
      await viewer.getByRole("searchbox").fill("ada");
      assert.equal(await viewer.locator(".qt-json-match").count(), 2);
      await viewer.getByRole("button", { name: "Copy JSON", exact: true }).click();
      assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).customer.name, "Ada");
      await viewer.getByRole("button", { name: "Close Payload · JSON", exact: true }).click();
      assert.equal(await open.evaluate(button => button === document.activeElement), true);
    };
    await section.getByRole("button", { name: "Expand item 1", exact: true }).click();
    const expanded = section.getByRole("region", { name: "Expanded item 1", exact: true });
    await verifyCompact(expanded);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await expanded.getByRole("button", { name: "Collapse item 1", exact: true }).click();

    await section.getByRole("button", { name: "Preview item 2", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Item preview", exact: true });
    await verifyCompact(popover);
    assert.equal(await page.getByRole("dialog").count(), 1);
    await popover.getByRole("button", { name: "Close item preview", exact: true }).click();

    await section.getByRole("button", { name: "Open item 3 in modal", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Item details", exact: true });
    await verifyCompact(details);
    assert.equal(await details.getByRole("button", { name: "Inspect Payload", exact: true }).count(), 0);
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
    await page.goto(process.env.QT_DEMO_URL || "http://localhost:5179/cells");
    await verifyReadingLayout(page, mobile);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Cell displays: per-column line clamping under virtualization, desktop/mobile decoding, copy, list buckets, search modes/navigation, inline item details, view editing and shared restoration passed.");
} finally { await browser.close(); }
