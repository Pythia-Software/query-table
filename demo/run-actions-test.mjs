// Start npm run demo first; QT_DEMO_URL can also target a production preview.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const url = new URL("/run-actions", process.env.QT_DEMO_URL ?? "http://localhost:5179/").href;
const screenshots = new URL("../.context/run-actions/", import.meta.url);
await mkdir(screenshots, { recursive: true });

async function checkLayout(page, fixture, touch) {
  const actions = fixture.locator(".qt-qb-run-actions");
  const geometry = await actions.evaluate(group => {
    const box = group.getBoundingClientRect();
    const buttons = [...group.querySelectorAll("button")].filter(b => b.getBoundingClientRect().width > 0);
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      contained: buttons.every(b => {
        const r = b.getBoundingClientRect();
        return r.left >= box.left - 1 && r.right <= box.right + 1 && r.width >= 1 && r.height >= 1;
      }),
      boxes: buttons.map(b => {
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }),
      statusOverflow: [...group.querySelectorAll(".qt-qb-auto-status")].some(s => s.scrollWidth > s.clientWidth + 1),
    };
  });
  assert.equal(geometry.overflow, false, "page has no horizontal overflow");
  assert.equal(geometry.contained, true, "all actions fit in the run group");
  assert.equal(geometry.statusOverflow, false, "polling status fits");
  for (let i = 0; i < geometry.boxes.length; i++) {
    const a = geometry.boxes[i];
    if (touch) assert(a.width >= 44 && a.height >= 44, "touch targets are at least 44px");
    for (const b of geometry.boxes.slice(i + 1)) {
      assert(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, "actions never overlap");
    }
    const previous = geometry.boxes[i - 1];
    if (previous) assert(a.y > previous.y + 1 || (Math.abs(a.y - previous.y) <= 1 && a.x > previous.x), "visual order follows DOM order");
  }
}

async function checkDialog(page, button, activation = "keyboard") {
  await button.focus();
  if (activation === "touch") await button.tap();
  else await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Orders data readiness", exact: true });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /include all pending changes/);
  await Promise.all([
    dialog.evaluate(d => new Promise(resolve => d.addEventListener("close", resolve, { once: true }))),
    dialog.getByRole("button", { name: "Close readiness" }).click(),
  ]);
  await dialog.waitFor({ state: "hidden" });
  assert(await button.evaluate(b => document.activeElement === b), "host dialog restores focus");
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const viewport of [
      { width: 1440, height: 1000 }, { width: 820, height: 1000 },
      { width: 760, height: 1000 }, { width: 390, height: 844 },
      { width: 320, height: 740 }, { width: 844, height: 390 },
    ]) {
      const touch = viewport.width <= 760 || viewport.height <= 500;
      // macOS WebKit uses Option+Tab to include buttons in native tab traversal.
      const tab = name === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
      const backTab = name === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab";
      const page = await browser.newPage({ viewport, hasTouch: touch });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(url);
      const orders = page.locator('[data-builder="Orders"]');
      const inventory = page.locator('[data-builder="Inventory"]');
      const empty = page.locator('[data-builder="Without slot"]');
      const readiness = orders.getByRole("button", { name: "Orders data readiness", exact: true });
      await readiness.waitFor();
      const original = await readiness.elementHandle();
      assert.equal(await orders.locator(".qt-qb-editor-bar").count(), 1);
      assert.equal(await inventory.locator(".qt-qb-editor-bar").count(), 0);
      assert.equal(await empty.locator(".qt-qb-run-actions > *").count(), 3, "empty slot adds no element");
      await checkDialog(page, readiness, touch ? "touch" : "keyboard");
      const iconColor = await readiness.locator("svg").evaluate(s => getComputedStyle(s).color);
      // Keyboard order matches the rendered order. The focus ring is visible.
      await readiness.focus();
      await page.keyboard.press(tab);
      assert(await orders.getByRole("button", { name: "Request activity", exact: true }).evaluate(b => b === document.activeElement));
      await page.keyboard.press(backTab);
      assert(await readiness.evaluate(b => b.matches(":focus-visible") && getComputedStyle(b).outlineStyle !== "none"));
      for (const label of ["Request activity", "Auto-Update", "Run Now"]) {
        await page.keyboard.press(tab);
        assert(await orders.getByRole("button", { name: label, exact: true }).evaluate(b => b === document.activeElement), `Tab reaches ${label}`);
      }

      for (const collapsed of [false, true]) {
        if (collapsed) {
          await orders.locator(".qt-qb-collapse-btn").click();
          await empty.locator(".qt-qb-collapse-btn").click();
        }
        await checkLayout(page, orders, touch);
        await checkLayout(page, inventory, touch);
        await checkLayout(page, empty, touch);
        // All three controls keep working with and without a host action.
        for (const fixture of [orders, empty]) {
          const activity = fixture.getByRole("button", { name: "Request activity", exact: true });
          await activity.click();
          await fixture.getByRole("region", { name: "Request activity", exact: true }).waitFor();
          assert.match(await fixture.locator(".qt-request-activity").textContent(), /Host-owned request diagnostics/);
          await activity.click();
          await fixture.getByRole("button", { name: "Run Now", exact: true }).click();
          await fixture.getByRole("button", { name: "Auto-Update", exact: true }).click();
          const settings = page.getByRole("dialog", { name: "Auto-refresh settings", exact: true });
          await settings.getByRole("combobox").first().selectOption("5000");
          await settings.getByRole("button", { name: "Start", exact: true }).click();
          await fixture.locator(".qt-qb-auto-status").waitFor();
          await checkLayout(page, fixture, touch);
        }
        await checkDialog(page, readiness);
        for (const fixture of [orders, empty]) {
          await fixture.getByRole("button", { name: "Auto-Update 5s", exact: true }).click();
          await page.getByRole("dialog", { name: "Auto-refresh settings", exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
          assert.equal(await fixture.locator(".qt-qb-auto-status").count(), 0);
        }
      }
      for (const label of ["Simulate loading", "Simulate error"]) {
        await orders.getByLabel(label).check();
        assert.equal(await readiness.isEnabled(), true);
        await checkDialog(page, readiness);
        await orders.getByLabel(label).uncheck();
      }
      await page.getByRole("button", { name: /^Rerender host/ }).click();
      assert(await original.evaluate(b => b.isConnected), "rerenders keep the original host node");
      assert.equal(await readiness.count(), 1);
      assert.equal(await readiness.getAttribute("data-open-count"), "5", "local host state survives transitions");
      assert.equal(await inventory.getByRole("button", { name: "Inventory data readiness" }).getAttribute("data-open-count"), "0", "builders have independent state");
      assert.equal(await readiness.locator("svg").evaluate(s => getComputedStyle(s).color), iconColor, "host status icon retains its color");
      // Keep screenshots compact, with active polling and the editor collapsed.
      await orders.getByRole("button", { name: "Auto-Update", exact: true }).click();
      await page.getByRole("dialog", { name: "Auto-refresh settings", exact: true }).getByRole("button", { name: "Start", exact: true }).click();
      if (viewport.width === 390) {
        await page.waitForFunction(() => document.querySelector('[data-builder="Orders"] .qt-qb-auto-status')?.textContent.includes("(2 polls run)"));
        assert(await original.evaluate(b => b.isConnected), "polling preserves host identity");
      }
      await page.screenshot({ path: new URL(`${name}-${viewport.width}x${viewport.height}.png`, screenshots).pathname, fullPage: true });
      const other = await inventory.getByRole("button", { name: "Inventory data readiness" }).elementHandle();
      await page.getByRole("button", { name: "Toggle first builder", exact: true }).click();
      assert(await other.evaluate(b => b.isConnected), "unmounting one builder preserves the other");
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`${name} ${viewport.width}x${viewport.height}: run actions passed`);
    }
  } finally { await browser.close(); }
}
