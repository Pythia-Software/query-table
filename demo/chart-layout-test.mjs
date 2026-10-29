// Start npm run demo first. QT_DEMO_URL can target a production preview too.
// Checks containment and behaviour, not pixel sizes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const screenshots = new URL("../.context/chart-layout/", import.meta.url);
await mkdir(screenshots, { recursive: true });
for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(new URL("/chart-layout", process.env.QT_DEMO_URL ?? "http://localhost:5179/").href);
      await page.locator("[data-chart=line] svg").waitFor();
      await page.waitForTimeout(300);
      const where = `${engineName} ${width}px`;

      // Request 1: every SVG label stays inside its chart and keeps its start.
      const labels = await page.locator(".qt-demo-chart-card svg").evaluateAll(svgs => svgs.flatMap(svg => {
        const chart = svg.closest("[data-chart]").dataset.chart, bounds = svg.getBoundingClientRect();
        return [...svg.querySelectorAll("text")].map(text => {
          const box = text.getBoundingClientRect(), title = text.querySelector("title")?.textContent ?? null;
          const shown = [...text.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("");
          return { chart, shown, title, inside: box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5 };
        });
      }));
      for (const label of labels) assert.ok(label.inside, `${where}: ${label.chart} label "${label.shown}" stays inside its SVG`);
      for (const chart of ["box", "bars", "bars-compact"]) {
        const rows = labels.filter(label => label.chart === chart && (label.title ?? "").length > 20);
        assert.ok(rows.length >= 3, `${where}: ${chart} draws long labels`);
        for (const row of rows) assert.ok(row.title.startsWith(row.shown.replace(/…$/, "")), `${where}: ${chart} keeps the start of "${row.title}"`);
      }
      assert.ok(labels.some(label => label.chart === "box" && label.shown === "short"), `${where}: short labels stay whole`);

      // Request 2: whole-key colours.
      const colours = await page.locator("[data-chart=pie] [data-qt-metric-color]").evaluateAll(marks => marks.map(mark => mark.dataset.qtMetricColor));
      assert.equal(new Set(colours).size, 3, `${where}: three provider/model slices, three colours`);

      // Request 4: the visible low point wins over a padded zero beside it.
      await page.locator("[data-chart=line]").scrollIntoViewIfNeeded();
      const point = async name => page.locator(`[data-chart=line] .qt-metric-mark[aria-label^="${name}"] circle`).evaluate(circle => {
        const box = circle.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      const read = await point("2026-10-03 / Read"), bash = await point("2026-10-03 / Bash");
      assert.ok(Math.abs(read.y - bash.y) < 12, `${where}: the two points overlap their old hit areas`);
      await page.mouse.click(read.x, read.y);
      assert.equal(await page.locator("[data-inspected]").textContent(), "Inspected 2026-10-03 / Read", `${where}: low point`);
      await page.mouse.click(bash.x, bash.y);
      assert.equal(await page.locator("[data-inspected]").textContent(), "Inspected 2026-10-03 / Bash", `${where}: zero point`);
      await page.mouse.move(read.x, read.y);
      await page.getByRole("tooltip").filter({ hasText: "2026-10-03 / Read" }).waitFor();
      // Keyboard still reaches each point directly.
      await page.locator('[data-chart=line] .qt-metric-mark[aria-label^="2026-10-02 / Bash"]').focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("[data-inspected]").textContent(), "Inspected 2026-10-02 / Bash", `${where}: keyboard`);

      assert.deepEqual(errors, [], `${where}: no page errors`);
      await page.screenshot({ path: new URL(`${engineName.toLowerCase()}-${width}.png`, screenshots).pathname, fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
console.log("chart layout checks passed");
