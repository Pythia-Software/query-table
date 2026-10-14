import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  decodeQueryStrict,
  predicatesOf,
} from "../packages/core/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = resolve(root, ".context");
await mkdir(screenshots, { recursive: true });
let server,
  base = process.env.QT_SHOWCASE_URL;
if (!base) {
  const directory = resolve(root, "demo/dist-showcase");
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      if (!pathname.startsWith("/query-table/")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const path = resolve(
        directory,
        pathname.slice("/query-table/".length) || "index.html",
      );
      if (!path.startsWith(`${directory}/`)) throw Error("Invalid path");
      const bytes = await readFile(path);
      response.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".json": "application/json",
          ".svg": "image/svg+xml",
        }[extname(path)] ?? "application/octet-stream",
      );
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/query-table/`;
}
const browser = await chromium.launch({
  ...(process.env.CI
    ? {}
    : { channel: process.env.QT_BROWSER_CHANNEL ?? "chrome" }),
  headless: true,
});
const errors = [],
  network = [];
async function ready(page) {
  await page
    .locator(".showcase-table .qt-row")
    .first()
    .waitFor({ timeout: 60000 });
  await page.waitForFunction(
    () =>
      (document.querySelectorAll(".qt-metric").length > 0 ||
        !document.querySelector(".showcase-metrics .qt-metrics")) &&
      document.querySelectorAll(".qt-metric-loading").length === 0 &&
      !document.querySelector(".qt-loading-bar"),
    undefined,
    { timeout: 60000 },
  );
  assert.equal(
    await page
      .locator(".showcase-error, .qt-metrics-error, .showcase-fatal")
      .count(),
    0,
    await page.locator("body").innerText(),
  );
}
function record(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => network.push(request.url()));
}
async function enterTopic(page) {
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  if (await guide.getAttribute("data-tour-preview") !== "true") return;
  await guide.getByRole("button", { name: "Learn more", exact: true }).click();
  await page.locator('.showcase-tour[data-tour-preview="false"]').waitFor();
}
async function topicChoices(page, mobile = false) {
  const id = mobile ? "food" : "311";
  await page.goto(`${base}?dataset=${id}`);
  await ready(page);
  await page.getByRole("button", { name: mobile ? "High protein" : "Brooklyn noise", exact: true }).click();
  await ready(page);
  const query = () => decodeQueryStrict(new URL(page.url()).searchParams.get(`q_${id}`));
  const initial = query();
  await page.getByRole("button", { name: "Take the tour", exact: true }).click();
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  const atPreview = async (topic) => {
    await page.locator(`.showcase-tour[data-tour-preview="true"][data-tour-chapter="${topic}"]`).waitFor();
    await page.waitForFunction(() => !!document.querySelector('.showcase-tour-arrow'));
    assert(await guide.getByRole("button", { name: "Learn more", exact: true }).count());
    assert.equal(await guide.getByRole("button", { name: "Do it for me", exact: true }).count(), 0);
  };
  for (const topic of ["idea", "table", "query", "metrics", "views"]) {
    await atPreview(topic);
    assert.deepEqual(query(), initial, "Browsing and skipping previews preserve the current query");
    if (topic === "query") {
      assert.equal(await guide.locator('h2').innerText(), "Compose your own query");
      await page.waitForFunction(() => {
        const region = document.querySelector('.showcase-query').getBoundingClientRect();
        const ring = document.querySelector('.showcase-tour-ring').getBoundingClientRect();
        return ring.left <= Math.max(0, region.left) && ring.right >= Math.min(innerWidth, region.right) && ring.top <= Math.max(0, region.top) && ring.bottom >= Math.min(innerHeight, region.bottom);
      });
      await page.screenshot({ path: resolve(screenshots, `showcase-tour-choices-${mobile ? 'mobile' : 'desktop'}.png`) });
    }
    if (topic !== "views")
      await guide.getByRole("button", { name: "Skip to next topic", exact: true }).click();
  }
  const original = page.viewportSize();
  if (mobile) {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForFunction(() => document.querySelector('.showcase-tour').scrollWidth <= document.querySelector('.showcase-tour').clientWidth);
    await page.setViewportSize(original);
  }
  await guide.getByRole("button", { name: "Previous step", exact: true }).click();
  await atPreview("metrics");
  assert.deepEqual(query(), initial, "Going back through previews preserves the query too");
  await guide.getByLabel("Choose a topic").selectOption("query");
  await atPreview("query");
  assert.deepEqual(query(), initial, "Choosing a topic opens its preview without resetting the view");
  await enterTopic(page);
  await ready(page);
  assert.equal(await guide.getAttribute("data-tour-step"), "column");
  assert.equal(query().where.length, 0, "Only Learn more establishes the guided example");
  await guide.getByRole("button", { name: "Do it for me", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.showcase-tour')?.getAttribute('data-tour-result') === 'true' && !document.querySelector('.showcase-tour-next')?.disabled);
  await ready(page);
  const changed = query();
  await guide.getByRole("button", { name: "Previous step", exact: true }).click();
  await atPreview("query");
  assert.deepEqual(query(), changed, "Returning to the preview keeps the work already done");
  await guide.getByRole("button", { name: "Skip to next topic", exact: true }).click();
  await atPreview("metrics");
  await guide.getByRole("button", { name: "Skip to next topic", exact: true }).click();
  await atPreview("views");
  await guide.getByRole("button", { name: "Finish tour", exact: true }).click();
  await page.getByText("Tour complete. Keep exploring.", { exact: true }).waitFor();
  const invitation = page.getByRole("dialog", { name: "Build with Query Table", exact: true });
  await invitation.getByRole("heading", { name: "Take this into your app", exact: true }).waitFor();
  if (mobile) {
    await invitation.getByRole("button", { name: "See integration examples", exact: true }).click();
    await invitation.getByRole("heading", { name: "A library inside your product", exact: true }).waitFor();
    await invitation.getByRole("button", { name: "Close Build with Query Table", exact: true }).click();
  } else {
    await invitation.getByRole("button", { name: "Keep exploring", exact: true }).click();
  }
  assert.deepEqual(query(), changed, "Declining the remaining topics keeps the current view");
  assert.equal(await page.locator('.showcase-tour-overlay').count(), 0);
  console.log(`${mobile ? "Mobile" : "Desktop"} previews, opt-in learning, skips, topic jumps, reconsidering and finishing passed`);
}
async function integrationGuide(page, mobile = false) {
  await page.goto(`${base}?dataset=311`);
  await ready(page);
  await page.getByRole("button", { name: "Brooklyn noise", exact: true }).click();
  await ready(page);
  await page.waitForFunction(expected => {
    const stored = JSON.parse(localStorage.getItem('query-table:last:showcase-v1:311') ?? 'null');
    return JSON.stringify(stored?.where) === JSON.stringify(expected);
  }, decodeQueryStrict(new URL(page.url()).searchParams.get('q_311')).where);
  const initialUrl = page.url();
  const initialCatalogue = await page.locator(".showcase-sidebar").innerText();
  const stored = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const initialStorage = await stored();
  const appearance = await page.locator(".showcase").evaluate(element => getComputedStyle(element).colorScheme);
  // Direct access is also useful when a visitor opts out of the guided tour.
  await page.getByRole("button", { name: "Take the tour", exact: true }).click();
  await page.getByRole("button", { name: "Build with Query Table", exact: true }).click();
  assert.equal(await page.locator(".showcase-tour-overlay").count(), 0);
  const dialog = page.getByRole("dialog", { name: "Build with Query Table", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).colorScheme), appearance === "dark" ? "light" : "dark");
  const topic = async (label, index) => {
    await dialog.getByRole("navigation", { name: "Integration topics" }).getByRole("button", { name: label, exact: true }).click();
    await dialog.locator(`[data-build-slide="${index}"]`).waitFor();
  };
  const preview = dialog.locator(".build-preview");
  const matches = async (total) => {
    await preview.getByText(`${total} matching orders`, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.build-preview .qt-loading-bar'));
  };
  const focusContained = async () => {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), "Keyboard focus stays inside the guide");
    }
  };
  const layout = async () => {
    await page.waitForFunction(viewport => {
      const footer = document.querySelector('.build-footer')?.getBoundingClientRect();
      return innerWidth <= viewport.width + 1 && footer && footer.top >= 0 && footer.bottom <= viewport.height + 1;
    }, page.viewportSize());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page overflow with integration guide");
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "Guide fits the viewport");
    const footer = await dialog.locator(".build-footer").boundingBox();
    assert(footer && footer.y >= 0 && footer.y + footer.height <= page.viewportSize().height + 1, "Slide navigation remains visible");
  };
  await layout();
  await page.screenshot({ path: resolve(screenshots, `showcase-build-integrate-${mobile ? "mobile" : "desktop"}.png`) });
  await dialog.getByText("See the React integration", { exact: true }).click();
  assert((await dialog.locator("pre").innerText()).includes("useQueryTable({ schema, transport })"));
  await dialog.getByRole("button", { name: "Native macOS", exact: true }).click();
  if (!await dialog.locator("pre").isVisible())
    await dialog.getByText("See the Swift integration", { exact: true }).click();
  assert((await dialog.locator("pre").innerText()).includes("QueryTableView(controller: table)"));
  assert((await dialog.getByRole("link", { name: "Native setup & compatibility" }).getAttribute("href")).endsWith("/native/macos"));
  for (const [label, suffix] of [["PostgreSQL", "docs/host-integration-next-release.md"], ["SQLite", "docs/backend-sqlite.md"], ["DuckDB", "packages/duckdb"]]) {
    await dialog.getByRole("button", { name: label, exact: true }).click();
    assert((await dialog.getByRole("link", { name: `${label} integration`, exact: true }).getAttribute("href")).endsWith(suffix));
  }
  await focusContained();
  await topic("Boundaries", 1);
  await dialog.getByRole("button", { name: "Inspect an example request", exact: true }).click();
  const originalRequest = JSON.parse(await dialog.locator("pre").innerText());
  assert(originalRequest.select && originalRequest.limit === 5);
  await layout();
  await topic("Defaults", 2);
  await matches(8);
  assert.equal(await dialog.getByRole("button", { name: "Schema defaults", exact: true }).getAttribute("aria-pressed"), "true");
  await dialog.getByRole("button", { name: "High value", exact: true }).click();
  await matches(4);
  assert.equal(await preview.locator('[data-qt-field="status"]').count(), 0, "Preset changes the columns too");
  assert.equal(await preview.locator('.qt-row [data-qt-field="total"]').first().innerText(), "310.00", "Preset applies descending numeric sort");
  await dialog.getByRole("button", { name: "Open orders", exact: true }).click();
  await matches(4);
  assert.equal(await preview.locator('.qt-row [data-qt-field="status"]').count(), 4);
  await layout();
  await topic("Views & links", 3);
  await matches(4);
  await dialog.getByRole("button", { name: "Save example view", exact: true }).click();
  await dialog.getByRole("button", { name: "Restore Example view 1", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Reset example", exact: true }).click();
  await matches(8);
  await dialog.getByRole("button", { name: "Restore Example view 1", exact: true }).click();
  await matches(4);
  await dialog.getByRole("button", { name: "Create inline link", exact: true }).click();
  await dialog.locator('[data-link-kind="inline"]').waitFor();
  const inline = await dialog.locator(".build-link-result code").innerText();
  await dialog.getByRole("button", { name: "Reset example", exact: true }).click();
  await matches(8);
  await dialog.getByRole("button", { name: "Open link in preview", exact: true }).click();
  await matches(4);
  await dialog.getByRole("button", { name: "Create short link", exact: true }).click();
  await dialog.locator('[data-link-kind="durable"]').waitFor();
  assert((await dialog.locator(".build-link-result code").innerText()).length < inline.length);
  await dialog.getByRole("button", { name: "Reset example", exact: true }).click();
  await matches(8);
  await dialog.getByRole("button", { name: "Open link in preview", exact: true }).click();
  await matches(4);
  assert((await dialog.locator(".build-status").innerText()).includes("fresh resolver read the snapshot"));
  await layout();
  await topic("Boundaries", 1);
  await dialog.getByRole("button", { name: "Inspect an example request", exact: true }).click();
  const beforeTheme = JSON.parse(await dialog.locator("pre").innerText());
  await topic("Theme", 4);
  await matches(4);
  await dialog.getByLabel("Example accent", { exact: true }).selectOption("#6549b6");
  await dialog.getByLabel("Example corners", { exact: true }).selectOption("14");
  assert.equal(await preview.evaluate(element => getComputedStyle(element).getPropertyValue("--qt-accent")), "#6549b6");
  assert.equal(await preview.evaluate(element => getComputedStyle(element).borderRadius), "14px");
  await dialog.getByRole("button", { name: "Toggle first row selection", exact: true }).click();
  assert(await preview.locator('.qt-row input[type="checkbox"]').first().isChecked());
  await layout();
  if (mobile) {
    const original = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 700 });
    for (const [label, index] of [["Integrate", 0], ["Boundaries", 1], ["Defaults", 2], ["Views & links", 3], ["Theme", 4]]) {
      await topic(label, index);
      await layout();
    }
    await page.setViewportSize(original);
  }
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(screenshots, `showcase-build-theme-${mobile ? "mobile" : "desktop"}.png`) });
  await topic("Boundaries", 1);
  await dialog.getByRole("button", { name: "Inspect an example request", exact: true }).click();
  assert.deepEqual(JSON.parse(await dialog.locator("pre").innerText()), beforeTheme, "Restyling keeps the query unchanged");
  assert.equal(page.url(), initialUrl, "Guide never edits the main URL");
  assert.equal(await page.locator(".showcase-sidebar").innerText(), initialCatalogue, "Guide never changes the main saved catalogue");
  assert.equal(await stored(), initialStorage, "Example storage stays isolated from browser persistence");
  await dialog.getByRole("button", { name: "Close Build with Query Table", exact: true }).click();
  assert.equal(await page.locator("body").evaluate(element => element.style.overflow), "");
  await page.getByRole("button", { name: "Build with Query Table", exact: true }).click();
  await topic("Views & links", 3);
  await matches(8);
  assert.equal(await dialog.locator(".build-saved button, .build-link-result").count(), 0, "Reopening creates a fresh example host");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Build with Query Table", exact: true }).evaluate(element => element === document.activeElement), true);
  const switchTheme = page.getByRole("button", { name: appearance === "dark" ? "Switch to light mode" : "Switch to dark mode", exact: true });
  await switchTheme.click();
  await page.getByRole("button", { name: "Build with Query Table", exact: true }).click();
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).colorScheme), appearance);
  await dialog.getByRole("button", { name: "Close Build with Query Table", exact: true }).click();
  await page.getByRole("button", { name: appearance === "dark" ? "Switch to dark mode" : "Switch to light mode", exact: true }).click();
  console.log(`${mobile ? "Mobile" : "Desktop"} integration slides, adapters, defaults, links, styling and isolation passed`);
}
async function compactTour(page, mobile = false) {
  await page.goto(`${base}?dataset=${mobile ? "food" : "311"}`);
  await ready(page);
  await page.getByRole("button", { name: "Take the tour", exact: true }).click();
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  const next = () => guide.getByRole("button", { name: /^(Learn more|Continue)$/, exact: true }).click();
  assert.equal(await guide.locator('h2').innerText(), "One query, a complete view");
  assert.equal(await guide.locator('.showcase-tour-state [data-icon=eye]').count(), 1);
  assert(!/Chapter \d|Lesson \d|Look what changed/.test(await guide.innerText()));
  await next();
  const title = await guide.locator('h2').innerText();
  assert.equal(await guide.locator('.showcase-tour-state [data-icon=pointer]').count(), 1);
  assert.equal(await guide.getByRole("group", { name: "Tour controls" }).getByRole("button").count(), 3);
  assert.equal(await guide.getByRole("button", { name: "Continue", exact: true }).count(), 0);
  await page.waitForFunction(() => !document.querySelector('.showcase-tour-actions .qt-btn-primary')?.disabled);
  const grip = guide.getByRole("button", { name: "Move tour card", exact: true });
  await grip.click({ trial: true }); // Wait for placement before coordinate-based dragging.
  const before = await guide.boundingBox();
  const handle = await grip.boundingBox();
  const origin = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const destination = { x: mobile ? 12 : 30, y: mobile ? 12 : 630 };
  const pointer = {
    x: origin.x + destination.x - before.x,
    y: origin.y + destination.y - before.y,
  };
  const paths = () => page.locator('.showcase-tour-arrow').evaluateAll(es => es.map(e => e.getAttribute('d')));
  const beforePaths = await paths();
  const touch = mobile ? await page.context().newCDPSession(page) : null;
  if (touch) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [origin] });
    await page.waitForFunction(() => document.querySelector('.showcase-tour')?.getAttribute('data-tour-dragging') === 'true');
    for (let i = 1; i <= 8; i++)
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: origin.x + (pointer.x - origin.x) * i / 8, y: origin.y + (pointer.y - origin.y) * i / 8 }],
      });
  } else {
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.showcase-tour')?.getAttribute('data-tour-dragging') === 'true');
    await page.mouse.move(pointer.x, pointer.y, { steps: 8 });
  }
  await page.waitForFunction(({ x, y }) => {
    const r = document.querySelector('.showcase-tour').getBoundingClientRect();
    return Math.abs(r.x - x) < 2 && Math.abs(r.y - y) < 2;
  }, destination);
  assert.notDeepEqual(await paths(), beforePaths, "Arrows follow the card before the pointer is released");
  assert(await page.locator('.showcase-tour-arrow').count(), "A moved card remains connected to its target");
  if (touch) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.detach();
  } else await page.mouse.up();
  await guide.getByRole("button", { name: "Do it for me", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.showcase-tour')?.getAttribute('data-tour-result') === 'true' && !document.querySelector('.showcase-tour-next')?.disabled);
  assert.equal(await guide.locator('h2').innerText(), title, "The topic title remains stable after the action");
  assert.equal(await guide.locator('.showcase-tour-state [data-icon=eye]').count(), 1);
  assert.equal(await guide.getByRole("button", { name: "Do it for me", exact: true }).count(), 0);
  const moved = await guide.boundingBox();
  assert(Math.abs(moved.x - destination.x) < 2 && Math.abs(moved.y - destination.y) < 2, "The chosen position survives result changes");
  const anchored = await page.evaluate(() => {
    const bounds = document.querySelector('.showcase-tour').getBoundingClientRect();
    return [...document.querySelectorAll('.showcase-tour-arrow')].every(path => {
      const start = path.getPointAtLength(0);
      return Math.min(Math.abs(start.x - bounds.left), Math.abs(start.x - bounds.right), Math.abs(start.y - bounds.top), Math.abs(start.y - bounds.bottom)) <= 9;
    });
  });
  assert(anchored, "Each arrow originates at a facing edge of the dragged card");
  await page.screenshot({ path: resolve(screenshots, `showcase-tour-compact-${mobile ? 'mobile' : 'dragged'}.png`) });
  await grip.focus();
  await grip.press("ArrowDown");
  await page.waitForFunction(y => Math.abs(document.querySelector('.showcase-tour').getBoundingClientRect().y - y) < 2, moved.y + 24);
  await grip.press("Shift+ArrowUp");
  await page.waitForFunction(y => Math.abs(document.querySelector('.showcase-tour').getBoundingClientRect().y - y) < 2, moved.y + 18);
  await next();
  const persisted = await guide.boundingBox();
  assert(Math.abs(persisted.y - (moved.y + 18)) < 2, "The chosen position survives moving to the next topic");
  const original = page.viewportSize();
  await page.setViewportSize({ width: mobile ? 320 : 640, height: 480 });
  await page.waitForFunction(() => {
    const r = document.querySelector('.showcase-tour').getBoundingClientRect();
    return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11;
  });
  await page.setViewportSize(original);
  await grip.press("Home");
  await page.waitForFunction(y => Math.abs(document.querySelector('.showcase-tour').getBoundingClientRect().y - y) > 2, persisted.y);
  const automatic = await guide.boundingBox();
  assert(Math.abs(automatic.y - persisted.y) > 2, "Home restores automatic placement");
  await guide.getByRole("button", { name: "End tour", exact: true }).click();
  console.log(`${mobile ? "Touch" : "Mouse"} drag, live arrows, compact states, keyboard movement, persistence and viewport bounds passed`);
}
async function walkthrough(page, context, id) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}?dataset=${id}`);
  await ready(page);
  const query = () =>
    decodeQueryStrict(new URL(page.url()).searchParams.get(`q_${id}`));
  const beforeStart = query();
  await page
    .getByRole("button", { name: "Take the tour", exact: true })
    .click();
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  const at = async (step) => {
    await page.locator(`[data-tour-step="${step}"]${step === "concept" ? "" : '[data-tour-preview="false"]'}`).waitFor();
    await page.waitForFunction(
      () => !!document.querySelector(".showcase-tour-arrow"),
    );
  };
  const next = async () => {
    const control = guide.getByRole("button", {
      name: /^(Learn more|Continue|Finish tour)$/,
    });
    await page.waitForFunction(
      () =>
        !document.querySelector(".showcase-tour-actions .qt-btn-primary")
          ?.disabled,
    );
    await control.click();
  };
  async function assisted(step) {
    await enterTopic(page);
    await at(step);
    await guide
      .getByRole("button", { name: "Do it for me", exact: true })
      .click();
    try {
      await page.waitForFunction(
        () =>
          document
            .querySelector(".showcase-tour")
            ?.getAttribute("data-tour-result") === "true" &&
          !document.querySelector(".showcase-tour-actions .qt-btn-primary")
            ?.disabled,
        undefined,
        { timeout: 30000 },
      );
    } catch (error) {
      await page.screenshot({
        path: resolve(
          screenshots,
          `showcase-chapter-failure-${id}-${step}.png`,
        ),
      });
      console.error(await guide.innerText());
      throw error;
    }
    try {
      await ready(page);
    } catch (error) {
      await page.screenshot({
        path: resolve(
          screenshots,
          `showcase-chapter-failure-${id}-${step}.png`,
        ),
      });
      console.error(await guide.innerText());
      console.error(await page.locator(".showcase-metrics").innerText());
      throw error;
    }
    assert.equal(await page.locator(".showcase-tour-error").count(), 0);
    try {
      await page.waitForFunction(() => !!document.querySelector('.showcase-tour-arrow--result'), undefined, { timeout: 5000 });
    } catch (error) {
      await page.screenshot({ path: resolve(screenshots, `showcase-arrow-failure-${id}-${step}.png`) });
      console.error(`${id}/${step}: result arrow missing`, await guide.innerText());
      throw error;
    }
    const bounds = await guide.boundingBox();
    assert(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= page.viewportSize().width + 1 &&
        bounds.y + bounds.height <= page.viewportSize().height + 1,
      "Card fits the viewport",
    );
  }
  await at("concept");
  assert.deepEqual(
    query(),
    beforeStart,
    "Starting the curriculum preserves the current view",
  );
  assert.equal(
    await guide.getAttribute("data-tour-theme"),
    "dark",
    "Light table has a dark tour card",
  );
  const opacity = await page.locator(".showcase-tour-scrim").evaluate((e) =>
    Number(
      getComputedStyle(e)
        .fill.match(/[\d.]+/g)
        .at(-1),
    ),
  );
  assert(opacity <= 0.2, "The backdrop remains readable");
  await page.screenshot({
    path: resolve(screenshots, `showcase-chapters-${id}-light.png`),
  });
  await page
    .getByRole("button", { name: "Switch to dark mode", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".showcase-tour")
        ?.getAttribute("data-tour-theme") === "light",
  );
  await page.screenshot({
    path: resolve(screenshots, `showcase-chapters-${id}-dark.png`),
  });
  await page
    .getByRole("button", { name: "Switch to light mode", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".showcase-tour")
        ?.getAttribute("data-tour-theme") === "dark",
  );
  const original = page.viewportSize();
  await page.setViewportSize({
    width: id === "food" ? 320 : 1040,
    height: 768,
  });
  await page.waitForFunction(() => {
    const r = document.querySelector(".showcase-tour").getBoundingClientRect();
    return r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  });
  await page.setViewportSize(original);
  await next();
  const first =
    id === "311" ? "problem" : id === "trips" ? "pickup_at" : "product";
  const column =
    id === "311" ? "channel" : id === "trips" ? "tip_ratio" : "countries";
  const sort =
    id === "311" ? "closure_seconds" : id === "trips" ? "total" : "sugar_g";
  const formulaName =
    id === "311"
      ? "Closure hours"
      : id === "trips"
        ? "Tip percentage"
        : "Sugar / protein";
  const steps = [
    "narrow",
    "table-sort",
    "table-filter",
    "resize",
    "reorder",
    "select",
    "details",
    "column",
    "combine",
    "formula",
    "group",
    "summary",
    "having",
    "metric",
    "drilldown",
    "undo",
    "save",
    "restore",
    "example",
    "share",
  ];
  let beforeChart, savedName;
  for (const step of steps) {
    if (step === "drilldown") beforeChart = query().where;
    await assisted(step);
    const q = query();
    if (step === "narrow") assert(q.where.length > 0);
    if (step === "table-sort")
      assert.deepEqual(q.orderBy, [{ field: sort, dir: "desc" }]);
    if (step === "table-filter") assert(q.where.length > 0);
    if (step === "resize")
      assert(q.select.find((c) => c.field === first).width > 0);
    if (step === "reorder") assert.notEqual(q.select[0].field, first);
    if (step === "select")
      assert((await page.locator(".qt-row--selected").count()) > 0);
    if (step === "column") assert(q.select.some((c) => c.field === column));
    if (step === "combine")
      assert(q.where.some((t) => "any" in t && t.any.length === 2));
    if (step === "formula") {
      assert(q.select.some((c) => c.field.startsWith("@computed/")));
      assert(
        (await page.locator(".showcase-table thead").innerText()).includes(
          formulaName,
        ),
      );
      const cells = await page
        .locator('.showcase-table .qt-row [data-qt-field^="@computed/"]')
        .allTextContents();
      assert(
        cells.some((v) => /\d/.test(v)),
        "DuckDB evaluates the authored formula",
      );
      assert(
        !cells.some((v) =>
          /error|pending|Calculating|Definition changed/i.test(v),
        ),
      );
      await page.screenshot({
        path: resolve(screenshots, `showcase-chapter-formula-${id}.png`),
      });
    }
    if (step === "group") assert(q.grouping?.keys.length === 1);
    if (step === "summary")
      assert(q.grouping.summaries.some((s) => s.op === "count"));
    if (step === "having") {
      const count = q.grouping.summaries.find((s) => s.op === "count").id;
      assert(
        q.where.some(
          (p) => p.field === count && p.op === ">" && p.value === "5",
        ),
      );
      const cells = await page
        .locator(`.qt-row [data-qt-field="${count}"]`)
        .allTextContents();
      assert(
        cells.length > 0 &&
          cells.every((v) => Number(v.replaceAll(",", "")) > 5),
      );
    }
    if (step === "drilldown") assert(q.where.length > beforeChart.length);
    if (step === "undo") assert.deepEqual(q.where, beforeChart);
    if (step === "save") {
      savedName = `My ${id === "311" ? "NYC 311" : id === "trips" ? "NYC taxi trips" : "Open Food Facts"} view`;
      assert(
        await page
          .getByRole("button", { name: savedName, exact: true })
          .count(),
      );
    }
    if (step === "example") assert(q.grouping);
    await next();
  }
  await page
    .getByText("Tour complete. Keep exploring.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(
        ".showcase-tour-overlay,.showcase-tour-target,body.showcase-tour-running",
      )
      .count(),
    0,
  );
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: savedName, exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".showcase-table h2")?.textContent === "Records",
  );
  await ready(page);
  await page
    .getByRole("button", { name: "Take the tour", exact: true })
    .click();
  await at("concept");
  await guide
    .getByLabel("Choose a topic", { exact: true })
    .selectOption("metrics");
  await enterTopic(page);
  await at("metric");
  await ready(page);
  assert(!query().grouping, "Chapters establish their own record view");
  await guide
    .getByRole("button", { name: "Skip to next topic", exact: true })
    .click();
  await enterTopic(page);
  await at("save");
  await ready(page);
  assert.equal(await guide.getByLabel("Choose a topic").inputValue(), "views");
  await guide.getByLabel("Choose a topic").selectOption("table");
  await enterTopic(page);
  await at("table-sort");
  await ready(page);
  assert.equal(
    query().where.length,
    0,
    "Jumping chapters does not inherit unrelated filters",
  );
  await guide.getByRole("button", { name: "End tour", exact: true }).click();
  const beforeRestart = query();
  await page
    .getByRole("button", { name: "Take the tour", exact: true })
    .click();
  await page.getByRole("button", { name: "Restart tour", exact: true }).click();
  await at("concept");
  await guide.getByRole("button", { name: "End tour", exact: true }).click();
  assert.deepEqual(
    query(),
    beforeRestart,
    "Restart and end preserve the current view",
  );
  assert.equal(
    await page
      .locator(
        ".showcase-tour-overlay,.showcase-tour-target,body.showcase-tour-running",
      )
      .count(),
    0,
  );
  console.log(
    `${id}: 21 lessons, real assisted actions, opposite themes, result arrows, chapter navigation and persistence passed`,
  );
}
async function nativeLessons(page, context) {
  await page.goto(`${base}?dataset=311`);
  await ready(page);
  await page
    .getByRole("button", { name: "Take the tour", exact: true })
    .click();
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  const at = (step) => page.locator(`[data-tour-step="${step}"][data-tour-preview="false"]`).waitFor();
  const next = async (step) => {
    await page.waitForFunction(
      () =>
        !document.querySelector(".showcase-tour-actions .qt-btn-primary")
          ?.disabled,
    );
    await guide
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await enterTopic(page);
    await at(step);
  };
  const field = async (label) => {
    await page.getByLabel("Search fields", { exact: true }).fill(label);
    await page
      .locator(".qt-picker-item")
      .filter({
        has: page.locator(".qt-picker-label").getByText(label, { exact: true }),
      })
      .click();
  };
  await guide.getByLabel("Choose a topic").selectOption("table");
  await enterTopic(page);
  await at("table-sort");
  await ready(page);
  await page.locator('th[data-qt-field="closure_seconds"]').click();
  await page
    .getByRole("menuitem", { name: "Set Sort (Desc)", exact: true })
    .click();
  await next("table-filter");
  await page.locator('.qt-row [data-qt-field="borough"]').first().click();
  await page.locator(".qt-cm-filter:not(.qt-cm-filter--neg)").first().click();
  await next("resize");
  await page
    .getByRole("separator", { name: "Resize Problem column", exact: true })
    .press("ArrowRight");
  await next("reorder");
  const target = page.locator('th[data-qt-field="status"]'),
    bounds = await target.boundingBox();
  await page.locator('th[data-qt-field="problem"]').dragTo(target, {
    targetPosition: { x: bounds.width - 8, y: bounds.height / 2 },
  });
  await next("select");
  await page.locator(".qt-row input[type=checkbox]").first().check();
  await next("details");
  await page.locator(".qt-item-detail-column button").first().click();
  await page.locator(".qt-object-inspector").waitFor();
  assert(
    await guide.evaluate((e) => !!e.closest("[role=dialog]")),
    "The guide joins the editor focus scope",
  );
  await page
    .getByRole("button", { name: "Close item details", exact: true })
    .click();
  await next("column");
  await ready(page);
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await field("Intake channel");
  await next("combine");
  // Let the advanced OR lesson apply its real controller intent; subsequent
  // formula/group lessons use the ordinary authoring controls.
  await guide
    .getByRole("button", { name: "Do it for me", exact: true })
    .click();
  await next("formula");
  await page
    .getByRole("button", { name: "Customize columns", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Computed column", exact: true })
    .click();
  const expression =
    'IF([status] = "Closed", ROUND([closure_seconds] / 3600, 1), NULL)';
  await page.getByLabel("Column name", { exact: true }).fill("Closure hours");
  await page
    .getByLabel("Computed column formula", { exact: true })
    .fill(expression);
  await page
    .getByRole("button", { name: "Save definition & add column", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save shared definition", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Apply columns", exact: true })
    .click();
  await next("group");
  await ready(page);
  await page.getByRole("button", { name: "Add group by", exact: true }).click();
  await field("Agency");
  await next("summary");
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await field("Row count");
  await next("having");
  const q = decodeQueryStrict(new URL(page.url()).searchParams.get("q_311"));
  const countId = q.grouping.summaries.find((s) => s.op === "count").id;
  const label = await page
    .locator(`th[data-qt-field="${countId}"] .qt-th-label`)
    .evaluate((e) =>
      [...e.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("")
        .trim(),
    );
  await page
    .getByRole("button", { name: "Add HAVING filter", exact: true })
    .click();
  await field(label);
  // The scalar editor exposes its operator as a compact choice button.
  const value = page.getByLabel(`Value for ${label}`, { exact: true });
  await value.fill("5");
  await page.waitForFunction(
    () => !document.querySelector(".showcase-tour-do")?.disabled,
  );
  await page
    .locator('.showcase-query [data-clause="having"] .qt-chip-op-btn')
    .click();
  await page.locator(".qt-op-cell").filter({ hasText: /^>$/ }).first().click();
  await next("metric");
  await ready(page);
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page
    .getByLabel("Metric name", { exact: true })
    .fill("Typical closure hours");
  await page
    .getByLabel("Metric expression", { exact: true })
    .fill("MEDIAN([closure_seconds]) / 3600");
  await page
    .getByRole("button", { name: "Apply metrics", exact: true })
    .click();
  await next("drilldown");
  await guide.getByRole("button", { name: "End tour", exact: true }).click();
  assert.equal(
    await page.locator(".showcase-tour-target,.showcase-tour-overlay").count(),
    0,
  );
  console.log(
    "Native header sort, cell filter, resize, drag, selection, details, formula, grouping, HAVING and metric editors passed",
  );
}
async function mobileEditorLesson(page) {
  await page.goto(`${base}?dataset=food`);
  await ready(page);
  await page
    .getByRole("button", { name: "Take the tour", exact: true })
    .click();
  const guide = page.getByRole("region", { name: "Guided tour", exact: true });
  await guide.getByLabel("Choose a topic").selectOption("metrics");
  await enterTopic(page);
  await ready(page);
  await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
  await page.getByLabel("Metric name", { exact: true }).waitFor();
  assert(await guide.evaluate((e) => !!e.closest("[role=dialog]")));
  // The sheet animates in and the guide remeasures into the editor's focus scope.
  await page.waitForFunction(() => {
    const card = document.querySelector('.showcase-tour')?.getBoundingClientRect();
    const input = document.querySelector('[aria-label="Metric name"]')?.getBoundingClientRect();
    return card && input && card.bottom <= input.top;
  });
  const guideRect = await guide.boundingBox(),
    nameRect = await page.getByLabel("Metric name").boundingBox();
  assert(
    guideRect.y + guideRect.height <= nameRect.y,
    "Compact guide leaves the editor unobstructed",
  );
  await guide
    .getByRole("button", { name: "Do it for me", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".showcase-tour")
        ?.getAttribute("data-tour-result") === "true",
  );
  await ready(page);
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "Assistance closes the draft before applying the actual measure",
  );
  assert(
    (await page.locator(".showcase-metrics").innerText()).includes(
      "Average protein",
    ),
  );
  await guide.getByRole("button", { name: "End tour", exact: true }).click();
  console.log("Mobile editor focus scope and assisted completion passed");
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
  });
  const page = await context.newPage();
  record(page);
  for (const [id, expected, recipe, grouped] of [
    ["311", 20519, "Brooklyn noise", "Compare agencies"],
    ["trips", 34406, "Airport pickups", "Compare neighborhoods"],
    ["food", 7949, "High protein", "Compare categories"],
  ]) {
    await page.goto(`${base}?dataset=${id}`);
    await ready(page);
    assert(
      (
        await page
          .locator(".showcase-table .showcase-section-heading")
          .innerText()
      ).includes(expected.toLocaleString("en-US")),
    );
    await page.getByRole("button", { name: recipe, exact: true }).click();
    await page.waitForFunction(
      (expected) => {
        const text =
          document.querySelector(".showcase-table .showcase-section-heading")
            ?.textContent ?? "";
        return (
          /matching/.test(text) &&
          !text.includes(expected.toLocaleString("en-US")) &&
          !!document.querySelector(".qt-row")
        );
      },
      expected,
      { timeout: 30000 },
    );
    await ready(page);
    assert(
      (
        await page
          .locator(".showcase-table .showcase-section-heading")
          .innerText()
      ).includes("matching"),
    );
    const linked = page.url();
    assert(
      linked.includes(`q_${id}=2`),
      "Query remains an inline portable link",
    );
    const fresh = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
    });
    const restored = await fresh.newPage();
    record(restored);
    await restored.goto(linked);
    await ready(restored);
    assert.equal(
      await restored
        .locator(".showcase-table .showcase-section-heading")
        .innerText(),
      await page
        .locator(".showcase-table .showcase-section-heading")
        .innerText(),
      "fresh browser restores the same filters",
    );
    await fresh.close();
    await page.getByRole("button", { name: grouped, exact: true }).click();
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector(
            ".showcase-table .showcase-section-heading > span",
          )?.textContent ?? "";
        const total = Number(text.replace(/[^0-9]/g, ""));
        return (
          document.querySelector(".showcase-table h2")?.textContent ===
            "Grouped results" &&
          total > 0 &&
          total < 1000 &&
          document.querySelectorAll(".qt-row").length > 0 &&
          !document.querySelector(".qt-loading-bar")
        );
      },
      undefined,
      { timeout: 30000 },
    );
    await ready(page);
    assert(
      (await page.locator(".showcase-table table").innerText()).includes(
        "Row count",
      ),
    );
    const all =
      id === "311"
        ? "All requests"
        : id === "trips"
          ? "All trips"
          : "All products";
    await page.getByRole("button", { name: all, exact: true }).click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".showcase-table h2")?.textContent ===
          "Records" &&
        document
          .querySelector(".showcase-table .showcase-section-heading > span")
          ?.textContent.includes(expected.toLocaleString("en-US")) &&
        !document.querySelector(".qt-loading-bar"),
      expected,
      { timeout: 30000 },
    );
    await ready(page);
    await page.locator(".qt-item-detail-column button").first().click();
    await page.getByRole("dialog").first().waitFor();
    await page.waitForFunction(
      () => {
        const text = document.querySelector("[role=dialog]")?.textContent ?? "";
        return text.length > 100 && !text.includes("Loading item");
      },
      undefined,
      { timeout: 30000 },
    );
    if (id === "food") {
      const viewer = page.getByRole("button", {
        name: /Open.*Nutrient data.*JSON|View.*Nutrient data.*JSON|Nutrient data.*JSON/i,
      });
      if (await viewer.count()) {
        await viewer.first().click();
        await page.getByPlaceholder("Search JSON").fill("name");
        assert(
          (await page.locator(".qt-json-search-count").innerText()).includes(
            "/",
          ),
        );
        await page.getByRole("button", { name: /Close.*JSON/ }).click();
      }
    }
    await page
      .getByRole("dialog")
      .first()
      .getByRole("button", { name: "Close item details", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Metrics dashboard" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(screenshots, `showcase-${id}-desktop.png`),
      fullPage: true,
    });
    console.log(
      `${id}: Wasm metrics, filters, grouping, item details and fresh-context URLs passed`,
    );
  }
  // Chart drilldown updates the real filter state, rather than only the card.
  await page.goto(`${base}?dataset=311`);
  await ready(page);
  await page.getByRole("button", { name: "All requests", exact: true }).click();
  await ready(page);
  await page
    .getByRole("group", { name: "Most reported problems", exact: true })
    .getByRole("button")
    .first()
    .click();
  await page.waitForFunction(() =>
    /Filtered by/.test(
      document.querySelector(".showcase-announcement")?.textContent ?? "",
    ),
  );
  await ready(page);
  const drilldown = decodeQueryStrict(
    new URL(page.url()).searchParams.get("q_311"),
  );
  assert(
    drilldown.where.some((term) =>
      predicatesOf(term).some((predicate) => predicate.field === "problem"),
    ),
    "Chart drilldown is a real saved-query predicate",
  );

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const phone = await mobile.newPage();
  record(phone);
  await phone.goto(`${base}?dataset=food`);
  await ready(phone);
  assert(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "No page-level horizontal overflow on mobile",
  );
  await phone.screenshot({
    path: resolve(screenshots, "showcase-food-mobile.png"),
    fullPage: true,
  });
  await walkthrough(page, context, "311");
  await walkthrough(page, context, "trips");
  await walkthrough(phone, mobile, "food");
  await compactTour(page);
  await compactTour(phone, true);
  await topicChoices(page);
  await topicChoices(phone, true);
  await integrationGuide(page);
  await integrationGuide(phone, true);
  await nativeLessons(page, context);
  await mobileEditorLesson(phone);
  await mobile.close();
  assert.deepEqual(errors, [], "No browser errors");
  const external = network.filter(
    (url) =>
      !["blob:", "data:"].some((prefix) => url.startsWith(prefix)) &&
      new URL(url).origin !== new URL(base).origin,
  );
  assert.deepEqual(
    [...new Set(external)],
    [],
    "Runtime assets and data are served from the same static origin",
  );
  await context.close();
  console.log(
    "Chart drilldown, mobile layout, subpath hosting and same-origin runtime passed",
  );
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
