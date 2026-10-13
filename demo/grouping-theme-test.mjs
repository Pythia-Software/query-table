// Client palettes must survive both inline editors and portalled mobile sheets.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const url = new URL("/grouping", process.env.QT_DEMO_URL ?? "http://localhost:5179").toString();
await mkdir(new URL("../.context/", import.meta.url), { recursive: true });
for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await browserType.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    colorScheme: "dark", // The OS must not replace an explicitly chosen cream palette.
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text) => { window.__shared = text; } },
  }));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const color = (locator, property = "color") => locator.evaluate((el, prop) => getComputedStyle(el)[prop], property);
  const picker = page.getByRole("dialog", { name: "Duration · show", exact: true });
  const editor = page.locator(".qt-columns-editor");
  const pick = (name) => page.locator(".qt-picker-item").filter({
    has: page.locator(".qt-picker-label", { hasText: new RegExp(`^${name}$`) }),
  }).click();
  const screenshot = async (name) => {
    if (engine === "chromium") await page.screenshot({
      path: new URL(`../.context/${name}.png`, import.meta.url).pathname,
      fullPage: page.viewportSize().width > 760, animations: "disabled",
    });
  };
  const bounds = async (locator) => {
    const box = await locator.boundingBox();
    const { width, height } = page.viewportSize();
    assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= height + 1, `${engine}: overlay fits viewport`);
  };
  try {
    await page.goto(url);
    await page.locator(".qt-table tbody tr").first().waitFor();
    await button("Busy workers").click();
    await page.locator('.qt-table .qt-column-role-badge[data-column-role="row"]').first().waitFor();
    await button("Share").click();
    const shared = await page.evaluate(() => window.__shared);
    const data = await page.locator(".qt-table tbody").innerText();
    const saved = await page.evaluate(() => localStorage.getItem("query-table:grouping-prototype:v2"));
    for (const [palette, background] of [
      ["default", "rgb(255, 255, 255)"],
      ["pharos-cream", "rgb(255, 250, 240)"],
      ["pharos-forest", "rgb(24, 53, 41)"],
    ]) {
      await page.getByLabel("Preview palette").selectOption(palette);
      assert.equal(await color(page.locator(".qt-qb-bar").first(), "backgroundColor"), background);
      for (const role of ["key", "aggregate", "row"]) {
        const chip = page.locator(`.qt-qb-row--select .qt-column-label[data-column-role="${role}"]`).first();
        const badge = page.locator(`.qt-table .qt-column-role-badge[data-column-role="${role}"]`).first();
        assert.equal(await color(chip), await color(badge), `${engine}: ${palette} ${role} matches header`);
      }
      await screenshot(`grouping-theme-${palette}`);
      await button("Add column").click();
      await pick("Duration");
      assert.equal(await color(picker, "backgroundColor"), background);
      const rowOption = picker.locator('.qt-column-picker-option[data-column-role="row"]');
      assert.equal(await color(rowOption), await color(page.locator('.qt-representative-trigger')));
      await bounds(picker);
      await button("Close field picker").click();
      await button("Customize columns").click();
      assert.equal(await color(editor, "backgroundColor"), background);
      await editor.locator(".qt-column-item-name").filter({ hasText: "Average Duration" }).click();
      const aggregateLabel = page.locator('.qt-qb-row--select .qt-column-label[data-column-role="aggregate"]').first();
      assert.equal(await color(editor.locator('.qt-column-title')), await color(aggregateLabel));
      await screenshot(`grouping-theme-${palette}-editor`);
      if (palette !== "default") {
        await button("Apply columns").hover();
        assert.equal(await color(button("Apply columns"), "backgroundColor"), palette === "pharos-cream" ? "rgb(32, 63, 49)" : "rgb(241, 214, 144)");
      }
      // The older, nested computed-column editor must inherit the same theme.
      await button("Computed columns…").click();
      assert.equal(await color(page.locator('.qt-select-editor'), "backgroundColor"), background);
      assert.equal(await color(page.locator('.qt-select-editor')), await color(editor));
      await page.locator('.qt-select-editor').getByRole("button", { name: "Close column editor", exact: true }).click();
      await button("Close column editor").click();
      await button("Edit representative row").click();
      const representative = page.getByRole("dialog", { name: "Representative row", exact: true });
      assert.equal(await color(representative, "backgroundColor"), background);
      await bounds(representative);
      await button("Close representative editor").click();
    }
    await button("Share").click();
    assert.equal(await page.evaluate(() => window.__shared), shared, `${engine}: theme does not enter shared query`);
    assert.equal(await page.locator(".qt-table tbody").innerText(), data);
    assert.equal(await page.evaluate(() => localStorage.getItem("query-table:grouping-prototype:v2")), saved);

    // A second instance inherits its own role tokens, not another table's palette.
    await page.evaluate(() => {
      const peer = document.createElement("div");
      peer.id = "theme-peer";
      peer.style.setProperty("--qt-column-key-color", "#345678");
      peer.append(document.querySelector('.qt-table [data-column-role="key"]').cloneNode(true));
      document.body.append(peer);
    });
    assert.equal(await color(page.locator('#theme-peer [data-column-role]')), "rgb(52, 86, 120)");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByLabel("Preview palette").selectOption("default");
      await page.getByLabel("Preview palette").selectOption("pharos-cream");
      await button("Customize columns").click();
      await bounds(editor);
      assert.equal(await editor.evaluate((el) => !!el.closest('.qt-grouping-page')), false, "Mobile editor is portalled");
      await page.locator('.qt-grouping-page').evaluate((el) => el.setAttribute('data-theme', 'pharos-forest'));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.qt-columns-editor')).backgroundColor === 'rgb(24, 53, 41)');
      await screenshot(`grouping-theme-forest-mobile-${width}`);
      // Host aliases resolve before copying to portals; every override survives.
      await page.locator('.qt-grouping-page').evaluate((el) => {
        for (const [key, value] of Object.entries({
          '--client-key': '#743d15', '--qt-column-key-color': 'var(--client-key)',
          '--qt-column-key-bg': '#ead5b2', '--qt-column-key-border': '#916234',
          '--qt-column-key-selected-bg': '#ddccbb', '--qt-column-key-hover-bg': '#eee1cc',
          '--qt-column-aggregate-color': '#c394ef', '--qt-column-aggregate-hover-bg': '#413852',
          '--qt-column-aggregate-selected-bg': '#322547', '--qt-column-aggregate-border': '#9e72bc',
        })) el.style.setProperty(key, value);
      });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.qt-columns-editor .qt-column-role-badge[data-column-role="key"]')).color === 'rgb(116, 61, 21)');
      const keyBadge = editor.locator('.qt-column-role-badge[data-column-role="key"]').first();
      assert.equal(await color(keyBadge, 'backgroundColor'), 'rgb(234, 213, 178)');
      const selected = editor.locator('.qt-column-items li.is-active');
      assert.equal(await color(selected, 'borderTopColor'), 'rgb(145, 98, 52)');
      assert.equal(await color(selected, 'backgroundColor'), 'rgb(221, 204, 187)');
      await editor.getByRole("button", { name: "Columns (5)", exact: true }).click();
      await editor.locator(".qt-column-item-name").filter({ hasText: "Average Duration" }).click();
      const selectedAggregate = editor.locator('.qt-column-choices .qt-editor-choice[aria-pressed="true"]');
      assert.equal(await color(selectedAggregate, "backgroundColor"), "rgb(50, 37, 71)");
      assert.equal(await color(selectedAggregate, "borderTopColor"), "rgb(158, 114, 188)");
      await button("Close column editor").click();
      await button("Add column").click();
      await pick("Duration");
      await bounds(picker);
      const aggregateOption = picker.locator('.qt-picker-item:has([data-column-role="aggregate"])').first();
      await aggregateOption.hover();
      assert.equal(await color(aggregateOption, 'backgroundColor'), 'rgb(65, 56, 82)');
      await button("Close Duration · show").click();
      await page.locator('.qt-grouping-page').evaluate((el) => el.removeAttribute('style'));
      assert.equal(await color(page.locator('#theme-peer [data-column-role]')), "rgb(52, 86, 120)");
    }
    await page.locator('#theme-peer').evaluate(el => el.remove());
    await page.setViewportSize({width: 1440, height: 1000});
    await button('Individual runs').click();
    assert.equal(await page.locator('[data-column-role]').count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${engine}: grouping palettes, scoped overrides, saved query isolation, nested editor and live mobile themes passed`);
  } finally {
    await browser.close();
  }
}
