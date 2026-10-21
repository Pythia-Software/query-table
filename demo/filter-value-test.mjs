// Start npm run demo first. QT_DEMO_URL can target a production preview too.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const names = ["exploration", "exploration-service", "exploration-service-v2", "gbw-utilities", "general-purpose-repository", "go-query-table-integration-with-a-long-unbroken-suffix-abcdefghijklmnopqrstuvwxyz"];
const screenshotDirectory = process.env.QT_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [1100, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, ...(width < 760 ? { hasTouch: true, isMobile: true } : {}) });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(new URL("/filter-values", process.env.QT_DEMO_URL ?? "http://localhost:5179/").href);
      await page.getByRole("heading", { name: "Filter value suggestions" }).waitFor();
      const combo = () => page.getByRole("combobox", { name: /^Value for / });
      const panel = () => page.locator(".qt-autocomplete-menu");
      const open = async () => {
        if (!await combo().count()) await page.getByRole("button", { name: /^Edit filter:/ }).click();
        if (width < 760) await combo().tap(); else await combo().click();
        await page.getByRole("option").first().waitFor();
      };
      const checkBounds = async () => {
        await page.waitForFunction(() => {
          const rect = document.querySelector(".qt-autocomplete-menu")?.getBoundingClientRect();
          return rect && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        });
        const box = await panel().boundingBox();
        const viewport = page.viewportSize();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
          `${engineName} ${width}: contained menu ${JSON.stringify(box)}`);
        assert.ok(await panel().evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.right - 3, rect.bottom - 3))
            && element.scrollWidth <= element.clientWidth;
        }), `${engineName} ${width}: menu unclipped, without horizontal overflow`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${engineName} ${width}: no page overflow`);
      };
      const pick = async name => {
        const option = page.getByRole("option", { name, exact: true });
        if (width < 760) await option.tap(); else await option.click();
      };
      const focused = async () => assert.ok(await combo().evaluate(element => element === document.activeElement), `${engineName} ${width}: input retains focus`);
      await open(); await checkBounds(); await focused();
      assert.deepEqual(await page.getByRole("option").allTextContents(), names);
      const triggerBox = await combo().boundingBox(), menuBox = await panel().boundingBox();
      if (width > 760) assert.ok(menuBox.width > triggerBox.width * 2, `${engineName}: menu extends beyond compact input`);
      for (const name of names) {
        const option = page.getByRole("option", { name, exact: true });
        await option.scrollIntoViewIfNeeded();
        assert.ok(await option.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          const optionRect = element.getBoundingClientRect();
          return Array.from(range.getClientRects()).every(rect => rect.left >= optionRect.left && rect.right <= optionRect.right && rect.top >= optionRect.top && rect.bottom <= optionRect.bottom);
        }), `${engineName} ${width}: full value readable: ${name}`);
      }
      if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/filter-values-${engineName.toLowerCase()}-${width}.png` });
      // Keyboard selection does not move DOM focus into the portalled options.
      await combo().press("ArrowDown"); await combo().press("ArrowDown"); await focused();
      assert.equal(await combo().getAttribute("aria-activedescendant"), await page.getByRole("option", { name: names[1], exact: true }).getAttribute("id"));
      await combo().press("Enter");
      assert.equal(await combo().inputValue(), names[1]); await focused();
      assert.equal(await page.getByRole("listbox").count(), 0);
      await combo().fill(""); await page.getByRole("option").last().waitFor();
      await pick(names.at(-1));
      assert.equal(await combo().inputValue(), names.at(-1)); await focused();
      await combo().fill("freeform-value");
      await page.getByRole("status").filter({ hasText: "No matching values" }).waitFor();
      assert.equal(await combo().inputValue(), "freeform-value");
      await combo().fill(""); await page.getByRole("option").last().waitFor();
      await combo().press("Escape");
      assert.equal(await page.getByRole("listbox").count(), 0); await focused();
      if (width < 760) assert.equal(await page.getByRole("dialog").count(), 1, "Escape leaves mobile filter dialog open");
      // Compare Tab with the browser's native order while suggestions are closed.
      await combo().press("Tab");
      const tabTarget = await page.evaluate(() => document.activeElement === document.body ? "body" : document.activeElement?.outerHTML);
      await combo().focus(); await combo().press("ArrowDown"); await combo().press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement === document.body ? "body" : document.activeElement?.outerHTML), tabTarget);
      assert.equal(await combo().inputValue(), "");
      assert.equal(await page.getByRole("listbox").count(), 0);
      if (width < 760) await page.getByRole("button", { name: /^Close / }).click();
      await page.getByRole("checkbox", { name: "Long list" }).check();
      await open();
      await page.getByRole("option", { name: "repository-69", exact: true }).waitFor({ state: "attached" });
      await checkBounds();
      await combo().press("ArrowUp");
      const lastOption = page.getByRole("option", { name: "repository-69", exact: true });
      await lastOption.waitFor({ state: "visible" });
      const lastBox = await lastOption.boundingBox(), scrollBox = await panel().boundingBox();
      assert.ok(lastBox.y >= scrollBox.y && lastBox.y + lastBox.height <= scrollBox.y + scrollBox.height, "keyboard reveals the last option");
      await combo().press("Escape");
      if (width < 760) await page.getByRole("button", { name: /^Close / }).click();
      if (width > 760) {
        await page.getByRole("checkbox", { name: "Near viewport edges" }).check();
        await open(); await checkBounds();
        await page.setViewportSize({ width: 850, height: 600 });
        await checkBounds(); await combo().press("Escape");
        await page.getByRole("checkbox", { name: "Near viewport edges" }).uncheck();
        await open();
        const before = await panel().boundingBox();
        await page.evaluate(() => window.scrollBy(0, 40));
        await page.waitForFunction(previous => document.querySelector('.qt-autocomplete-menu').getBoundingClientRect().y !== previous, before.y);
        await checkBounds(); await combo().press("Escape");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByRole("button", { name: "Open scrollable dialog" }).click();
        await open(); await checkBounds();
        const dialogBefore = await panel().boundingBox();
        await page.getByLabel("Scrollable content").evaluate(element => element.scrollBy(0, 40));
        await page.waitForFunction(previous => document.querySelector('.qt-autocomplete-menu').getBoundingClientRect().y !== previous, dialogBefore.y);
        await checkBounds(); await combo().press("Escape");
        assert.equal(await page.getByRole("dialog").count(), 1);
        await page.getByRole("button", { name: "Close Scrollable filter fixture" }).click();
      }
      await page.getByRole("button", { name: "Array filter", exact: true }).click();
      await open();
      await pick(names[2]);
      assert.equal(await combo().inputValue(), names[2]);
      assert.ok((await page.getByLabel("Current filter").innerText()).includes('"op":"includes"'));
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`${engineName} ${width}px: filter suggestions passed`);
    }
  } finally { await browser.close(); }
}
