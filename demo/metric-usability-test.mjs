import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
const output = new URL("../.context/usability-pass/", import.meta.url).pathname;
await mkdir(output, { recursive: true });

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1680, height: 1050 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
    await page
      .getByRole("button", { name: "Edit metrics", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
          ?.disabled,
    );
    const dialog = page.locator(".qt-metrics-editor");
    const workspace = page.locator(".qt-metric-workspace");
    const panels = page.getByRole("group", { name: "Visible editor panels" });
    const selected = page.getByLabel("Editing metric");
    const view = page.getByLabel("Workbench view");
    const dirty = page.locator(".qt-metrics-editor-footer > span");
    const draftStatus = await dirty.innerText();
    const widths = await workspace.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns,
    );
    await panels
      .getByRole("button", { name: "Metric list panel", exact: true })
      .click();
    await panels
      .getByRole("button", { name: "Fields & functions panel", exact: true })
      .click();
    assert.equal(await page.locator(".qt-metric-library").isVisible(), false);
    assert.equal(await page.locator(".qt-metric-reference").isVisible(), false);
    await page.waitForTimeout(100);
    const divider = page.getByRole("separator", {
      name: "Resize metric panes 2 and 4",
    });
    const beforeDivider = Number(await divider.getAttribute("aria-valuenow"));
    await divider.press("ArrowRight");
    assert.equal(
      Number(await divider.getAttribute("aria-valuenow")),
      beforeDivider + 10,
    );
    await panels
      .getByRole("button", { name: "Definition panel", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Live preview panel", exact: true })
        .isDisabled(),
      true,
    );
    await selected.selectOption("latency");
    await panels
      .getByRole("button", { name: "Definition panel", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Metric name", { exact: true }).inputValue(),
      "Average duration",
    );
    await page
      .getByRole("button", { name: "Reset layout", exact: true })
      .click();
    await page.waitForTimeout(100);
    assert.equal(
      await workspace.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns,
      ),
      widths,
    );
    assert.equal(await dirty.innerText(), draftStatus);

    // Editing state and selected metric survive the contextual round trip.
    await selected.selectOption("pass-platform");
    const display = page
      .locator(".qt-metric-definition .qt-metric-settings > summary")
      .filter({ hasText: "Display" });
    await display.click();
    await page
      .getByLabel("Metric name", { exact: true })
      .fill("Platform success");
    await panels
      .getByRole("button", { name: "Fields & functions panel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "See in dashboard", exact: true })
      .click();
    assert.equal(await view.inputValue(), "dashboard");
    assert.equal(
      await page.getByLabel("Selected metric").inputValue(),
      "pass-platform",
    );
    const contextualCard = page.locator('[data-metric-id="pass-platform"]');
    assert.equal(
      await contextualCard.evaluate((el) => document.activeElement === el),
      true,
    );
    assert.equal(await contextualCard.isVisible(), true);
    assert.equal(
      await page.getByLabel("Layout metric name").inputValue(),
      "Platform success",
    );
    await page
      .getByRole("button", { name: "Back to metric", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Metric name", { exact: true }).inputValue(),
      "Platform success",
    );
    assert.equal(await display.evaluate((el) => el.parentElement.open), true);
    assert.equal(await page.locator(".qt-metric-reference").isVisible(), false);
    assert.equal(
      await page
        .getByLabel("Metric name", { exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await page
      .getByLabel("Metric name", { exact: true })
      .fill("Pass rate by platform");
    assert.equal(await dirty.innerText(), draftStatus);
    await page.screenshot({
      path: `${output}/metric-editor-${engine.name()}.png`,
    });
    await page
      .getByRole("button", { name: "See in dashboard", exact: true })
      .click();

    // Canvas geometry is temporary; keyboard, pointer, Escape and cancel agree.
    const edge = page.getByRole("separator", {
      name: "Resize dashboard canvas",
      exact: true,
    });
    const canvasInput = page.getByLabel("Canvas width", { exact: true });
    await edge.press("ArrowLeft");
    assert.equal(await canvasInput.inputValue(), "1110");
    await edge.press("Home");
    await edge.scrollIntoViewIfNeeded();
    const edgeBounds = await edge.boundingBox();
    const x = edgeBounds.x + edgeBounds.width / 2,
      y = Math.max(edgeBounds.y, 360) + 50;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 137, y, { steps: 5 });
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Canvas width"]')?.value === "983",
      null,
      { timeout: 2000 },
    );
    assert.equal(await canvasInput.inputValue(), "983");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await canvasInput.inputValue(), "1120");
    assert.equal(await page.getByRole("dialog").count(), 1);
    assert.equal(
      await page.evaluate(() =>
        document.body.style.getPropertyValue("user-select"),
      ),
      "",
    );
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 223, y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await canvasInput.inputValue(), "897");
    assert.equal(await dirty.innerText(), draftStatus);
    await edge.press("Shift+ArrowRight");
    assert.equal(await canvasInput.inputValue(), "947");
    await edge.press("Home");
    await edge.evaluate((el) =>
      el.addEventListener(
        "pointerdown",
        (e) => {
          el.dataset.pointerId = e.pointerId;
        },
        { once: true },
      ),
    );
    await edge.scrollIntoViewIfNeeded();
    const cancelEdge = await edge.boundingBox();
    await page.mouse.move(cancelEdge.x + 9, 400);
    await page.mouse.down();
    await page.mouse.move(cancelEdge.x - 100, 400);
    await edge.evaluate((el) =>
      window.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: Number(el.dataset.pointerId),
        }),
      ),
    );
    await page.mouse.up();
    assert.equal(await canvasInput.inputValue(), "1120");

    // Preferred card geometry does affect the draft; cancelled gestures do not.
    await page.getByLabel("Selected metric").selectOption("pass-platform");
    const resizeCard = contextualCard.getByRole("button", {
      name: "Resize Pass rate by platform",
      exact: true,
    });
    await resizeCard.press("ArrowRight");
    assert.equal(
      await page.getByLabel("Width in rem", { exact: true }).inputValue(),
      "27",
    );
    await resizeCard.press("ArrowLeft");
    assert.equal(await dirty.innerText(), draftStatus);
    await resizeCard.scrollIntoViewIfNeeded();
    const corner = await resizeCard.boundingBox();
    const cx = corner.x + 10,
      cy = corner.y + 10;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 48, cy + 32, { steps: 4 });
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Width in rem"]')?.value === "29",
      null,
      { timeout: 2000 },
    );
    assert.equal(
      await page.getByLabel("Width in rem", { exact: true }).inputValue(),
      "29",
    );
    assert.equal(
      await page.getByLabel("Height in rem", { exact: true }).inputValue(),
      "15",
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(
      await page.getByLabel("Width in rem", { exact: true }).inputValue(),
      "26",
    );
    assert.equal(await dirty.innerText(), draftStatus);
    await contextualCard
      .getByRole("button", { name: "Edit Pass rate by platform", exact: true })
      .click();
    assert.equal(await selected.inputValue(), "pass-platform");

    // Removing has a visible recovery action and restores the same ordering.
    await selected.selectOption("runs");
    const list = page.locator(".qt-metric-library .qt-reorder-list");
    const originalIds = await list
      .locator("li")
      .evaluateAll((els) => els.map((el) => el.dataset.reorderId));
    const first = list.locator("li").first();
    await first.getByLabel("Actions for Runs in scope").click();
    await first.getByRole("button", { name: "Remove", exact: true }).click();
    assert.equal(await selected.inputValue(), "pass-rate");
    await page
      .getByRole("button", { name: "Undo remove", exact: true })
      .click();
    assert.deepEqual(
      await list
        .locator("li")
        .evaluateAll((els) => els.map((el) => el.dataset.reorderId)),
      originalIds,
    );
    assert.equal(await selected.inputValue(), "runs");
    assert.equal(await dirty.innerText(), draftStatus);

    // One click on a reference transitions from Basic into a populated formula.
    await panels
      .getByRole("button", { name: "Fields & functions panel", exact: true })
      .click();
    await page.getByRole("button", { name: "Basic", exact: true }).click();
    await page.getByLabel("Search metric reference").fill("platform");
    await page
      .locator(".qt-metric-reference-item")
      .filter({ has: page.locator("code").filter({ hasText: /^platform$/ }) })
      .click();
    const expression = page.getByRole("textbox", {
      name: "Metric expression",
      exact: true,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Metric expression"]')?.value ===
        "COUNT([platform])",
    );
    assert.equal(
      await expression.evaluate((el) => document.activeElement === el),
      true,
    );
    await expression.fill("COUNT()");
    // Invalid metrics are discoverable, while other metrics still preview.
    await expression.fill("SUM(");
    await page
      .getByRole("button", { name: "See in dashboard", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-metric-id="pass-rate"] .qt-metric-big-value')
        ?.textContent?.includes("%"),
    );
    await page
      .getByRole("button", { name: "Review 1 issue", exact: true })
      .click();
    assert.equal(await selected.inputValue(), "runs");
    assert.equal(await page.locator(".qt-metric-definition").isVisible(), true);
    assert.equal(
      await page.locator(".qt-metric-live-preview").isVisible(),
      true,
    );
    await expression.fill("COUNT()");
    await page.waitForFunction(
      () =>
        !document.querySelector(".qt-metrics-editor-footer button:last-of-type")
          ?.disabled,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await panels
      .getByRole("button", { name: "Metric list panel", exact: true })
      .click();
    await panels
      .getByRole("button", { name: "Fields & functions panel", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Apply metrics", exact: true })
        .isVisible(),
      true,
    );
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
    await page
      .getByRole("button", { name: "See in dashboard", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Phone · 360", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Apply metrics", exact: true })
        .isVisible(),
      true,
    );
    await page.setViewportSize({ width: 1680, height: 1050 });
    await page
      .getByRole("button", { name: "Desktop · 1200", exact: true })
      .click();
    await page.screenshot({
      path: `${output}/dashboard-editor-${engine.name()}.png`,
    });
    assert.deepEqual(errors, []);
    console.log(
      `${engine.name()}: panel geometry, contextual navigation, drag/keyboard/cancel resizing, undo, reference insertion, issue recovery and mobile containment passed.`,
    );
  } finally {
    await browser.close();
  }
}
