// Start npm run demo first. QT_DEMO_URL can also target a built preview.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch({ headless: true });
  try {
    let page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(new URL("/menus", process.env.QT_DEMO_URL ?? "http://localhost:5179/").href);
    const button = label => page.getByRole("button", { name: label, exact: true });
    const item = label => page.getByRole("menuitem", { name: label, exact: true });
    const menu = label => page.getByRole("menu", { name: label, exact: true });
    const focused = async label => assert.equal((await page.locator(":focus").innerText()).trim(), label, `${name}: focus ${label}`);
    const bounds = async label => {
      const panel = menu(label);
      await panel.waitFor({ state: "visible" });
      const box = await panel.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(box && box.x >= 7 && box.y >= 7 && box.x + box.width <= viewport.width - 7 && box.y + box.height <= viewport.height - 7, `${name}: ${label} fits viewport: ${JSON.stringify(box)}`);
      // Bounds alone do not reveal clipping by an ancestor.
      assert.ok(await panel.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.right - 3, rect.bottom - 3);
        return element.contains(hit);
      }), `${name}: ${label} is not clipped`);
    };
    const closeAll = async () => {
      for (let level = 0; level < 4 && await page.getByRole("menu").count(); level++) await page.keyboard.press("Escape");
      await menu("View actions").waitFor({ state: "detached" });
    };

    for (const palette of ["light", "dark", "warm"]) {
      await page.getByRole("combobox", { name: "Palette" }).selectOption(palette);
      await button("Open menu").click();
      await bounds("View actions");
      await page.keyboard.press("ArrowDown");
      await focused("Display"); // Disabled Duplicate is skipped.
      await page.keyboard.press("ArrowRight");
      await menu("Display").waitFor({ state: "visible" });
      await item("Alignment").press("ArrowRight");
      await bounds("Alignment");
      const colors = await page.getByRole("menu").evaluateAll(panels => panels.map(panel => {
        const style = getComputedStyle(panel);
        return [style.backgroundColor, style.color, style.fontFamily, style.colorScheme];
      }));
      assert.equal(colors.length, 3);
      assert.deepEqual(colors[0], colors[1], `${name}: ${palette} submenu inherits theme`);
      assert.deepEqual(colors[0], colors[2], `${name}: ${palette} deep submenu inherits theme`);
      // A host can change its scoped palette while menus remain mounted.
      await page.locator("main").evaluate((element, value) => element.setAttribute("data-theme", value), palette === "dark" ? "warm" : "dark");
      await page.waitForFunction(previous => getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor !== previous, colors[0][0]);
      const liveColors = await page.getByRole("menu").evaluateAll(panels => panels.map(panel => getComputedStyle(panel).backgroundColor));
      assert.ok(liveColors.every(color => color === liveColors[0]), `${name}: live palette updates all levels`);
      await closeAll();
      await focused("Open menu");
    }

    // The same scoped surface also serves exclusive action grids and forms.
    for (const palette of ["light", "dark", "warm"]) {
      await page.getByRole("combobox", { name: "Palette" }).selectOption(palette);
      await button("Paired actions").press("ArrowUp");
      await focused("Exclude B");
      await page.keyboard.press("Escape");
      await focused("Paired actions");
      await button("Paired actions").click();
      await button("Paired actions").click();
      assert.equal(await menu("Paired actions").count(), 0, `${name}: trigger toggles without reopening`);
      await button("Paired actions").click();
      await page.keyboard.press("ArrowDown");
      await focused("Keep B");
      await page.keyboard.press("ArrowRight");
      await focused("Exclude B");
      await page.keyboard.press("Enter");
      await focused("Paired actions");
      await button("Choose field").click();
      const fieldDialog = page.getByRole("dialog", { name: "Choose a field", exact: true });
      await fieldDialog.waitFor({ state: "visible" });
      const color = await fieldDialog.evaluate(element => getComputedStyle(element).backgroundColor);
      assert.equal(color, palette === "dark" ? "rgb(17, 24, 32)" : palette === "warm" ? "rgb(255, 247, 235)" : "rgb(255, 255, 255)", `${name}: ${palette} picker theme`);
      await page.getByRole("textbox", { name: "Search fields" }).fill("contact");
      await page.getByRole("textbox", { name: "Search fields" }).press("Enter");
      assert.equal(await page.getByRole("status").innerText(), "Selected Email");
      await focused("Choose field");
      await page.getByRole("button", { name: "Edit category filter value" }).click();
      await page.getByRole("textbox", { name: "Search category values" }).fill("Beta");
      await button("Beta beta").click();
      assert.equal(await page.getByRole("status").innerText(), "Selected beta");
      await button("Open settings").click();
      const input = page.getByRole("textbox", { name: "View name" });
      assert.equal(await input.evaluate(element => element === document.activeElement), true);
      await input.press("Tab");
      assert.equal(await page.getByRole("dialog", { name: "View settings" }).count(), 1, `${name}: Tab keeps a form open`);
      await button("Save settings").click();
      await focused("Open settings");
      await button("Open settings").click();
      await button("Open settings").click();
      assert.equal(await page.getByRole("dialog", { name: "View settings" }).count(), 0);
    }

    // Hover and diagonal travel across the gap must keep the submenu open.
    await button("Open menu").click();
    await item("Display").hover();
    await menu("Display").waitFor({ state: "visible" });
    const trigger = await item("Display").boundingBox();
    const child = await item("Alignment").boundingBox();
    await page.mouse.move(trigger.x + trigger.width - 4, trigger.y + trigger.height / 2);
    await page.mouse.move(child.x + child.width / 2, child.y + child.height / 2, { steps: 12 });
    await menu("Alignment").waitFor({ state: "visible" });
    await item("Align right").click();
    await menu("View actions").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("status").innerText(), "Align right");

    await button("Open menu").click();
    await item("Display").click();
    await page.mouse.move(20, 20);
    await menu("Display").waitFor({ state: "detached" });
    await focused("Display");
    await closeAll();

    for (const edge of ["Left edge", "Right edge", "Bottom edge"]) {
      await button(edge).click();
      await bounds("View actions");
      await item("Export").click();
      await bounds("Export");
      await item("Spreadsheet").press("ArrowRight");
      await bounds("Spreadsheet");
      await closeAll();
    }
    await button("Long menu").click();
    await bounds("View actions");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    await focused("Last submenu");
    await page.keyboard.press("ArrowRight");
    await bounds("Last submenu");
    await page.keyboard.press("End");
    await focused("Child 40");
    await item("Child 40").click();
    assert.equal(await page.getByRole("status").innerText(), "Selected child 40");

    // WebKit on macOS follows native keyboard-access settings, which can skip
    // buttons. Closing a menu should preserve that browser's normal Tab order.
    await button("Open menu").focus();
    await page.keyboard.press("Tab");
    const forwardTarget = await page.locator(":focus").evaluate(element => element.outerHTML);
    await button("Open menu").click();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").evaluate(element => element.outerHTML), forwardTarget, `${name}: native forward Tab order`);
    await button("Open menu").focus();
    await page.keyboard.press("Shift+Tab");
    const backwardTarget = await page.locator(":focus").evaluate(element => element.outerHTML);
    await button("Open menu").click();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator(":focus").evaluate(element => element.outerHTML), backwardTarget, `${name}: native backward Tab order`);
    await button("Open menu").click();
    await button("Bottom edge").focus();
    await menu("View actions").waitFor({ state: "detached" });

    await page.getByRole("checkbox", { name: "Right to left" }).check();
    await button("Open menu").click();
    await item("Display").press("ArrowLeft");
    await bounds("Display");
    await page.keyboard.press("ArrowRight");
    await focused("Display");
    await closeAll();
    await page.getByRole("checkbox", { name: "Right to left" }).uncheck();

    await button("Open dialog").click();
    await button("Dialog actions").click();
    await bounds("View actions");
    assert.equal(await menu("View actions").evaluate(panel => Boolean(panel.closest('[role="dialog"]'))), true);
    await item("Display").press("ArrowRight");
    await closeAll();
    assert.equal(await page.getByRole("dialog").count(), 1, `${name}: Escape leaves enclosing dialog open`);
    await focused("Dialog actions");
    await page.keyboard.press("Escape");

    await page.close();
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(new URL("/menus", process.env.QT_DEMO_URL ?? "http://localhost:5179/").href);
    await page.getByRole("combobox", { name: "Palette" }).selectOption("dark");
    await button("Open menu").tap();
    await page.locator(".qt-sheet").waitFor({ state: "visible" });
    await item("Display").tap();
    await page.getByRole("menuitemcheckbox", { name: "Compact rows" }).tap();
    assert.equal(await page.getByRole("menuitemcheckbox", { name: "Compact rows" }).getAttribute("aria-checked"), "false");
    assert.equal(await page.getByRole("menu").count(), 2, `${name}: toggles keep the sheet open`);
    await item("Alignment").tap();
    await menu("Alignment").waitFor();
    assert.equal(await menu("Alignment").evaluate(panel => getComputedStyle(panel).position), "static");
    const mobileColors = await page.getByRole("menu").evaluateAll(panels => panels.map(panel => getComputedStyle(panel).backgroundColor));
    assert.ok(mobileColors.every(color => color === "rgb(17, 24, 32)"), `${name}: scoped dark mobile theme`);
    await item("Align left").press("Escape");
    await focused("Alignment");
    assert.equal(await page.getByRole("menu").count(), 2);
    await closeAll();
    await focused("Open menu");
    assert.equal(await page.evaluate(() => document.body.style.overflow), "");
    await button("Choose field").tap();
    await page.getByRole("dialog", { name: "Choose a field", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Email email", exact: true }).tap();
    await focused("Choose field");
    await button("Open settings").tap();
    await page.getByRole("textbox", { name: "View name" }).fill("Mobile view");
    await button("Save settings").tap();
    await focused("Open settings");

    // Real consumers share the same surfaces, including actions in editor dialogs.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
    await page.waitForFunction(() => document.querySelector('.qt-row'));
    const jobHeader = page.locator('th[data-qt-field="job_name"]');
    const platformHeader = page.locator('th[data-qt-field="platform"]');
    await jobHeader.locator('.qt-th-label').click();
    await menu("Job column").waitFor({ state: "visible" });
    assert.equal(await jobHeader.getAttribute("aria-expanded"), "true");
    await jobHeader.locator('.qt-th-label').click();
    assert.equal(await page.getByRole("menu").count(), 0, `${name}: repeated header click closes menu`);
    assert.equal(await jobHeader.getAttribute("aria-expanded"), "false");
    await jobHeader.click();
    await item("Column Widths").click();
    await menu("Column Widths").waitFor({ state: "visible" });
    await jobHeader.click();
    assert.equal(await page.getByRole("menu").count(), 0, `${name}: header toggle dismisses submenu too`);
    await jobHeader.click();
    await platformHeader.click();
    await menu("Platform column").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("menu").count(), 1, `${name}: switching headers leaves one menu`);
    assert.equal(await jobHeader.getAttribute("aria-expanded"), "false");
    assert.equal(await platformHeader.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await platformHeader.evaluate(element => element === document.activeElement), true);
    await platformHeader.press("ArrowDown");
    await menu("Platform column").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await button("Add column").click();
    await page.getByRole("textbox", { name: "Search fields" }).press("Escape");
    await focused("add column");
    await button("Add sort").click();
    await page.getByRole("textbox", { name: "Search fields" }).press("Escape");
    await focused("add sort");
    await button("Add filter").click();
    await page.getByRole("button", { name: "Job job_name", exact: true }).click();
    await page.locator('.qt-op-trigger').press("ArrowUp");
    assert.equal(await page.getByRole("menuitemradio", { name: "is not null", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    await button("Auto-Update").click();
    const settings = page.getByRole("dialog", { name: "Auto-refresh settings", exact: true });
    await settings.getByRole("combobox").first().selectOption("10000");
    await page.keyboard.press("Escape");
    assert.equal(await settings.count(), 0);
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForFunction(expected => matchMedia("(max-width: 760px)").matches === expected, width <= 760);
      assert.equal(await page.getByRole("dialog").count(), 0, `${name}: resizing does not open a stale filter sheet`);
      await button("Add filter").click();
      await page.getByRole("button", { name: "Error codes error_codes", exact: true }).click();
      const tags = page.getByRole("dialog", { name: "Filter Error codes", exact: true });
      await tags.waitFor({ state: "visible" });
      assert.equal(await tags.getAttribute("aria-modal"), "true");
      await tags.getByRole("checkbox", { name: "Timeout timeout", exact: true }).check();
      await button("Apply filter").click();
      assert.equal(await tags.count(), 0);
      assert.equal(await page.getByRole("button", { name: "Edit Error codes tag filter", exact: true }).count(), 1);
      await page.getByRole("button", { name: "Remove Error codes tag filter", exact: true }).click();
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await button("Edit metrics").click();
    await button("Actions for Runs in scope").click();
    const metricMenu = menu("Actions for Runs in scope");
    assert.equal(await metricMenu.evaluate(element => Boolean(element.closest('[role="dialog"]'))), true);
    await item("Move down").click();
    assert.equal(await button("Actions for Runs in scope").evaluate(element => element === document.activeElement), true);
    await button("Actions for Runs in scope").click();
    await item("Remove").click();
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), "Metric name");
    await button("Cancel").click();

    assert.deepEqual(errors, [], `${name}: no runtime errors`);
    console.log(`${name}: menus passed (themes, hover, nested keys, grids, forms, real consumers, focus, RTL, dialogs, mobile)`);
  } finally {
    await browser.close();
  }
}
