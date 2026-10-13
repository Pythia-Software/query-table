// Property workbench geometry, scrolling and draft preservation.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base = process.env.QT_DEMO_URL ?? "http://localhost:5179";
await mkdir(".context", { recursive: true });

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("/objects", base).href);
    const card = page.locator(".qt-object-demo-item > .qt-object-inspector");
    await card.getByRole("button", { name: "Customize properties", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit properties", exact: true });
    const library = editor.getByRole("complementary", { name: "Selected properties" });
    const panels = editor.getByRole("group", { name: "Visible property panels" });
    const dividers = editor.locator('.qt-property-workspace > [role="separator"]');
    const add = library.getByRole("button", { name: "Add property", exact: true });
    const scroller = library.locator(".qt-property-editor-scroll");
    const originalCount = await library.locator(".qt-property-pick").count();
    const initialColumns = await editor.locator(".qt-property-workspace").evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    assert.equal(await panels.evaluate((el) => !!el.closest("header")), true);
    assert.ok(await library.locator(".qt-reorder-item").first().evaluate((el) => el.getBoundingClientRect().height <= 44));
    const heading = await library.getByRole("heading", { name: "Properties", exact: true }).boundingBox();
    const addBounds = await add.boundingBox();
    assert.ok(Math.abs(heading.y + heading.height / 2 - addBounds.y - addBounds.height / 2) < 2);
    assert.ok(addBounds.x > heading.x + heading.width);

    // Pointer and keyboard resizing use the same shared workbench as metrics.
    const divider = editor.getByRole("separator", { name: "Resize property panels 1 and 2", exact: true });
    const originalWidth = Number(await divider.getAttribute("aria-valuenow"));
    const bounds = await divider.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + 100, { steps: 5 });
    await page.mouse.up();
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), originalWidth + 40);
    await divider.press("ArrowLeft");
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), originalWidth + 30);

    // Hiding/reopening a panel and resetting layout must preserve edits.
    const label = editor.getByRole("textbox", { name: /^Label for / });
    await label.fill("Tool draft");
    await editor.getByRole("button", { name: "Hide display panel", exact: true }).click();
    assert.equal(await editor.locator(".qt-property-editor-definition").isVisible(), false);
    assert.equal(await dividers.count(), 1);
    await library.locator(".qt-property-pick").first().click();
    assert.equal(await label.inputValue(), "Tool draft");
    await panels.getByRole("button", { name: "Preview panel", exact: true }).click();
    assert.equal(await editor.locator(".qt-property-editor-preview").isVisible(), false);
    await panels.getByRole("button", { name: "Properties panel", exact: true }).click();
    assert.equal(await panels.getByRole("button", { name: "Display panel", exact: true }).isDisabled(), true);
    await editor.getByRole("button", { name: "Reset layout", exact: true }).click();
    assert.equal(await dividers.count(), 2);
    assert.equal(await label.inputValue(), "Tool draft");
    assert.equal(await editor.locator(".qt-property-workspace").evaluate((el) => getComputedStyle(el).gridTemplateColumns), initialColumns);

    // The list itself must not consume wheel events meant for the body.
    await editor.evaluate((el) => { el.style.height = "430px"; });
    await scroller.hover();
    await page.mouse.wheel(0, 450);
    await page.waitForFunction(() => document.querySelector(".qt-property-editor-scroll").scrollTop > 0);
    assert.equal(await library.locator(".qt-property-editor-list").evaluate((el) => el.scrollTop), 0);
    assert.equal(await library.evaluate((el) => el.scrollTop), 0);
    const fixedAdd = await add.boundingBox();
    assert.equal(await add.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true);
    await scroller.hover();
    await page.mouse.wheel(0, -450);
    await page.waitForFunction(() => document.querySelector(".qt-property-editor-scroll").scrollTop === 0);
    assert.deepEqual(await add.boundingBox(), fixedAdd);
    await add.click();
    const picker = page.getByRole("dialog", { name: "Choose a field", exact: true });
    await picker.locator(".qt-picker-item").first().click();
    assert.equal(await library.locator(".qt-property-pick").count(), originalCount + 1);
    await editor.getByRole("button", { name: "Reset layout", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".qt-property-editor").getBoundingClientRect().height > 700);

    const applyColors = await editor.getByRole("button", { name: "Apply properties", exact: true }).evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor];
    });
    assert.notEqual(...applyColors);
    await page.screenshot({ path: `.context/property-editor-${engine.name()}.png`, animations: "disabled" });

    // The same compact library remains scrollable within the mobile tabs.
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.getByRole("tab", { name: "Properties", exact: true }).click();
    assert.equal(await dividers.count(), 0);
    assert.equal(await editor.locator(".qt-property-editor-definition").isVisible(), false);
    await scroller.hover();
    await page.mouse.wheel(0, 450);
    await page.waitForFunction(() => document.querySelector(".qt-property-editor-scroll").scrollTop > 0);
    await add.click();
    await picker.locator(".qt-picker-item").last().click();
    assert.equal(await editor.locator(".qt-property-editor-definition").isVisible(), true);
    await editor.getByRole("tab", { name: "Properties", exact: true }).click();
    assert.equal(await library.locator(".qt-property-pick").count(), originalCount + 2);
    assert.equal(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: `.context/property-editor-${engine.name()}-mobile.png`, animations: "disabled" });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await card.locator("dt").first().innerText(), "Tool");
    assert.equal(await card.locator("dt").count(), originalCount);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: compact property rows, fixed Add button, wheel scrolling, shared resizing/panel controls, draft preservation and mobile tabs passed; preview screenshots saved.`);
  } finally {
    await browser.close();
  }
}
