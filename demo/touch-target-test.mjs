import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const themeUrl = new URL("../packages/ui/src/theme.css", import.meta.url);
const entry = await readFile(themeUrl, "utf8");
let theme = "";
for (const [, path] of entry.matchAll(/@import "(.+?)";/g)) {
  theme += await readFile(new URL(path, themeUrl), "utf8");
}
const url = process.env.QT_DEMO_URL ?? "http://localhost:5179/";
const screenshotDir = new URL("../.context/", import.meta.url);
await mkdir(screenshotDir, { recursive: true });

// Exercise the real cascade with semantic controls independently of demo skins.
// Assertions compare relative geometry; they do not pin the theme's pixel sizes.
const fixture = `
  <style>body { font: 14px/1.4 system-ui; margin: 8px; } .fixture { margin-bottom: 10px; }</style>
  <div class="qt-qb fixture">
    <div class="qt-qb-state-bar"><button data-control="state" class="qt-btn">Saved</button>
      <button data-control="collapse" class="qt-btn qt-qb-collapse-btn">Query</button></div>
    <div class="qt-qb-editor-bar"><button data-control="add" class="qt-add">Add filter</button></div>
    <div class="qt-qb-run-actions"><button data-control="run" class="qt-btn">Run now</button></div>
    <span data-control="chip" class="qt-chip">Field <button data-control="remove" class="qt-chip-x">×</button></span>
  </div>
  <div class="qt-qt-section-head fixture"><button data-control="section" class="qt-btn qt-qt-section-toggle">Table</button></div>
  <div class="qt-selection-toolbar fixture"><div class="qt-selection-actions"><button data-control="selection" class="qt-btn">Export</button></div></div>
  <div class="qt-picker-popover fixture" style="position:static"><div class="qt-picker">
    <input data-control="search" class="qt-picker-input" aria-label="Search fields" placeholder="Search fields">
    <div class="qt-picker-list"><button data-control="picker" class="qt-picker-item"><span class="qt-picker-row">Field name</span></button></div>
  </div></div>
  <div class="qt-menu-surface fixture" style="width:280px"><button data-control="menu" class="qt-cm-item">Menu action</button></div>
  <div class="qt-property-controls fixture"><button data-control="property" class="qt-btn">Properties</button></div>
  <div class="qt-metrics-editor qt-modal fixture" style="position:static; min-height:0; height:auto; width:100%; min-width:0">
    <div class="qt-metrics-editor-header"><button data-control="metricClose" class="qt-btn qt-metric-close">Close</button></div>
    <div class="qt-metrics-editor-footer"><button data-control="metricApply" class="qt-btn">Apply</button></div>
  </div>
  <div class="qt-select-editor fixture" data-overlay><div class="qt-select-editor-footer"><button data-control="selectApply" class="qt-btn">Apply</button></div></div>
  <div class="qt-property-editor fixture"><div class="qt-property-editor-footer"><button data-control="propertyApply" class="qt-btn">Apply</button></div></div>
  <div class="fixture"><button data-control="plain" class="qt-btn">Standalone</button></div>
  <div class="qt-json-actions fixture"><button data-control="json" class="qt-json-action">↑</button></div>
  <table class="qt-table fixture"><tbody><tr><td data-control="cell" class="qt-cell">Value</td></tr></tbody></table>
`;

async function geometry(page) {
  return page.locator("[data-control]").evaluateAll(elements => Object.fromEntries(elements.map(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return [element.dataset.control, {
      height: bounds.height, width: bounds.width,
      paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
      fontSize: parseFloat(style.fontSize),
    }];
  })));
}
async function setScale(page, factor, selector = "body") {
  await page.locator(selector).evaluate((element, factor) => {
    if (factor === null) element.style.removeProperty("--qt-touch-target-scale");
    else element.style.setProperty("--qt-touch-target-scale", String(factor));
  }, factor);
}
function near(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1.2, `${message}: ${actual} vs ${expected}`);
}

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await desktop.setContent(fixture);
    await desktop.addStyleTag({ content: theme });
    const baseline = await geometry(desktop);
    for (const factor of [0, 0.5, 1]) {
      await setScale(desktop, factor);
      assert.deepEqual(await geometry(desktop), baseline, `${name}: desktop geometry ignores factor`);
    }
    await desktop.close();

    for (const [viewport, hasTouch] of [
      [{ width: 390, height: 844 }, false],
      [{ width: 320, height: 740 }, true],
      [{ width: 1100, height: 900 }, true],
      [{ width: 844, height: 390 }, true],
    ]) {
      const page = await browser.newPage({ viewport, hasTouch });
      await page.setContent(fixture);
      await page.addStyleTag({ content: theme });
      const narrow = viewport.width <= 760 || viewport.height <= 500;
      if (narrow) await page.locator(".qt-picker-popover").evaluate(e => {
        e.classList.replace("qt-picker-popover", "qt-sheet");
      });
      if (narrow) await page.locator("[data-overlay]").evaluate(e => e.classList.add("qt-sheet"));
      const unset = await geometry(page);
      await setScale(page, 1);
      const full = await geometry(page);
      assert.deepEqual(full, unset, `${name}: unset retains full enlargement`);
      await setScale(page, 0);
      const zero = await geometry(page);
      await setScale(page, 0.5);
      const half = await geometry(page);
      for (const control of narrow
        ? ["state", "collapse", "add", "run", "remove", "section", "selection", "picker", "menu", "property", "json", "cell", "metricClose", "metricApply", "selectApply", "propertyApply"]
        : ["plain"]) {
        assert(half[control].height <= full[control].height + 1, `${name}: ${control} never grows when halved`);
        near(half[control].height, (zero[control].height + full[control].height) / 2,
          `${name} ${viewport.width}: ${control} adds half the final enlargement`);
      }
      // Fixed desktop controls give an independent baseline, including the
      // distinct 28px collapse controls and the 24px ordinary buttons.
      for (const control of narrow ? ["state", "collapse", "add", "run", "section", "selection"] : ["plain"]) {
        near(zero[control].height, baseline[control].height, `${name}: ${control} restores its desktop baseline`);
      }
      if (hasTouch) {
        near(half.plain.paddingTop, (full.plain.paddingTop + baseline.plain.paddingTop) / 2, `${name}: vertical padding scales`);
      }
      if (narrow) assert(half.search.fontSize >= 16, `${name}: input font avoids browser zoom`);
      await page.close();
    }

    // Real components verify scoped configuration crosses portals, remains live
    // while open, and does not disturb pointer/keyboard/focus behavior.
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
      for (const factor of [0, 0.5, 1]) {
        const page = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(url);
        await page.locator("tbody .qt-row").first().waitFor();
        await setScale(page, factor);
        await setScale(page, factor, ".qt-qb");
        const trigger = page.getByRole("button", { name: "Add filter", exact: true });
        await trigger.click();
        let sheet = page.locator(".qt-sheet").last();
        await sheet.waitFor();
        assert.equal((await sheet.evaluate(e => getComputedStyle(e).getPropertyValue("--qt-touch-target-scale"))).trim(), String(factor));
        const item = sheet.locator(".qt-picker-item").first();
        const configuredHeight = (await item.boundingBox()).height;
        await setScale(page, 1, ".qt-qb");
        await page.waitForFunction(() => Array.from(document.querySelectorAll(".qt-sheet")).some(e => getComputedStyle(e).getPropertyValue("--qt-touch-target-scale").trim() === "1"));
        const fullHeight = (await item.boundingBox()).height;
        assert(fullHeight + 1 >= configuredHeight, `${name}: live scope changes reach sheets (${configuredHeight} → ${fullHeight})`);
        await setScale(page, factor, ".qt-qb");
        await item.tap();
        sheet = page.locator(".qt-sheet").last();
        await sheet.locator(".qt-filter-editor").waitFor();
        for (const input of await sheet.locator('input:not([type="checkbox"]), select').all()) {
          const readable = await input.evaluate(e => {
            const s = getComputedStyle(e);
            const available = e.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
            return available >= parseFloat(s.fontSize) && parseFloat(s.fontSize) >= 16;
          });
          assert(readable, `${name}: mobile input text fits without reducing its font`);
        }
        await sheet.getByRole("button", { name: /^Close Filter by/ }).click();
        await page.getByRole("button", { name: "Customize columns", exact: true }).click();
        sheet = page.locator(".qt-sheet").last();
        await sheet.waitFor();
        await sheet.getByRole("button", { name: "Cancel layout changes", exact: true }).click();
        await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
        const metricDialog = page.getByRole("dialog", { name: "Edit metrics", exact: true });
        await metricDialog.waitFor();
        assert.equal((await metricDialog.evaluate(e => getComputedStyle(e).getPropertyValue("--qt-touch-target-scale"))).trim(), String(factor));
        await metricDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.locator(".qt-th-label").first().click();
        sheet = page.locator(".qt-sheet").last();
        await sheet.getByRole("menu").waitFor();
        assert.equal((await sheet.evaluate(e => getComputedStyle(e).getPropertyValue("--qt-touch-target-scale"))).trim(), String(factor));
        await sheet.getByRole("button", { name: /^Close/ }).click();
        const saved = page.getByRole("button", { name: "Saved", exact: true });
        await saved.focus();
        await saved.press("Enter");
        sheet = page.locator(".qt-sheet").last();
        await sheet.waitFor();
        await page.keyboard.press("Tab");
        assert(await sheet.evaluate(e => e.contains(document.activeElement)), `${name}: Tab stays within the sheet`);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".qt-sheet").count(), 0, `${name}: Escape dismisses the sheet`);
        assert(await saved.evaluate(e => e === document.activeElement), `${name}: sheet restores keyboard focus`);
        const wrapping = await page.locator(".qt-qb").evaluate(e => ({ width: e.clientWidth, scroll: e.scrollWidth }));
        assert(wrapping.scroll <= wrapping.width + 1, `${name}: builder wraps within its width`);
        assert.deepEqual(errors, []);
        if (viewport.width === 390 && factor === 0.5) await page.screenshot({ path: new URL(`touch-target-half-${name.toLowerCase()}.png`, screenshotDir).pathname });
        await page.close();
      }
    }
    console.log(`${name}: responsive target scaling and portal interactions passed`);
  } finally {
    await browser.close();
  }
}
