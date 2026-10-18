// Group link columns: real anchors, host routing through onNavigate for plain
// clicks only, and blocked links as muted text. Start the demo first.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { decodeQuery, encodeQuery, normalizeQueryState } from "../packages/core/dist/index.js";
// The npm script enables type stripping explicitly for Node 22.14–22.17.
import { RUNS } from "./src/data.ts";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
await mkdir(".context/grouping-links", { recursive: true });
const failing = { id: "failing", owns: ["filters"], query: { where: [{ field: "overall", op: "=", value: "FAIL" }] } };
const initial = normalizeQueryState({
  grouping: {
    source: normalizeQueryState({ select: [{ field: "id" }, { field: "platform" }, { field: "overall" }] }),
    keys: ["platform"],
    summaries: [
      { id: "n", op: "count" },
      { id: "failing", op: "link", label: "Failing runs", link: { label: { column: "platform" }, to: { kind: "query", target: "runs", patch: failing } } },
      { id: "missing", op: "link", label: "Unrouted", link: { label: "Open", to: { kind: "query", target: "missing" } } },
    ],
    representative: null,
  },
  select: [{ field: "platform" }, { field: "n" }, { field: "failing" }, { field: "missing" }],
  orderBy: [{ field: "platform", dir: "asc" }],
});
const query = (url) => decodeQuery(new URL(url).searchParams.get("q"));
const platforms = [...new Set(RUNS.map((run) => run.platform))].sort();

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?q=${encodeQuery(initial)}`);
  const links = page.locator(".qt-table tbody a.qt-group-link");
  await page.waitForFunction((count) => document.querySelectorAll(".qt-table tbody a.qt-group-link").length === count, platforms.length);
  assert.deepEqual(await links.allTextContents(), platforms);
  await page.getByRole("columnheader", { name: /Failing runs/ }).waitFor();

  // Each href is the composed query: the source, the group key and the patch.
  for (const [index, platform] of platforms.entries()) {
    const href = await links.nth(index).getAttribute("href");
    assert.match(href, /^\/\?q=/);
    const destination = query(new URL(href, origin).toString());
    assert.equal(destination.grouping, undefined);
    assert.deepEqual(destination.where, [
      { field: "platform", op: "=", value: platform },
      { field: "overall", op: "=", value: "FAIL" },
    ]);
  }
  // An unregistered target renders as muted text that explains why.
  const blocked = page.locator(".qt-table tbody .qt-group-link--blocked").first();
  assert.equal(await blocked.textContent(), "Open");
  assert.equal(await blocked.getAttribute("title"), 'Link target "missing" is not registered.');
  assert.equal(await page.locator('.qt-table tbody td[data-qt-field="missing"] a').count(), 0);
  await page.screenshot({ path: ".context/grouping-links/grouped.png", fullPage: true });

  // Modifier and middle clicks keep native behavior: a new tab, no onNavigate.
  await page.evaluate(() => { window.__qtMarker = "same document"; });
  const groupedUrl = page.url();
  for (const options of [{ modifiers: ["ControlOrMeta"] }, { button: "middle" }]) {
    const [popup] = await Promise.all([context.waitForEvent("page"), links.first().click(options)]);
    await popup.waitForURL((url) => url.searchParams.has("q"));
    assert.deepEqual(query(popup.url()).where, query(new URL(await links.first().getAttribute("href"), origin).toString()).where);
    await popup.close();
    assert.equal(page.url(), groupedUrl, JSON.stringify(options));
    assert.equal(await page.locator(".qt-table tbody a.qt-group-link").count(), platforms.length);
  }

  // The column editor lists link columns read-only and can remove them.
  await page.getByRole("button", { name: "Customize columns", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Select columns", exact: true });
  const items = editor.locator(".qt-column-items li");
  await editor.getByRole("button", { name: /^Failing runs/ }).click();
  const definition = editor.getByTestId("link-definition");
  assert.match(await definition.textContent(), /Opens.*runs.*Group filters.*One per group key.*Preset.*failing/);
  assert.match(await items.filter({ hasText: "Unrouted" }).textContent(), /Link · missing/);
  await editor.screenshot({ path: ".context/grouping-links/editor.png" });
  await editor.getByRole("button", { name: "Remove Unrouted", exact: true }).click();
  await editor.getByRole("button", { name: "Apply columns", exact: true }).click();
  await page.waitForURL((url) => !query(url.toString()).grouping?.summaries.some((s) => s.id === "missing"));
  assert.deepEqual(query(page.url()).select.map((c) => c.field), ["platform", "n", "failing"]);
  assert.equal(await page.locator(".qt-table tbody .qt-group-link--blocked").count(), 0);

  // A plain click goes through onNavigate: same document, query replaced.
  const failures = (platform) => RUNS.filter((run) => run.platform === platform && run.overall === "FAIL").length;
  const target = [...platforms].sort((a, b) => failures(b) - failures(a))[0];
  const expected = failures(target);
  assert.ok(expected > 0);
  await links.nth(platforms.indexOf(target)).click();
  await page.waitForURL((url) => !query(url.toString()).grouping);
  assert.equal(await page.evaluate(() => window.__qtMarker), "same document");
  await page.waitForFunction((count) => document.querySelectorAll(".qt-table tbody tr.qt-row").length === count, expected);
  assert.deepEqual([...new Set(await page.locator('.qt-table tbody td[data-qt-field="overall"]').allTextContents())], ["FAIL"]);
  assert.deepEqual([...new Set(await page.locator('.qt-table tbody td[data-qt-field="platform"]').allTextContents())], [target]);
  await page.screenshot({ path: ".context/grouping-links/followed.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`grouping links: ${platforms.length} links, ${expected} ${target} failing runs after a plain click`);
} finally {
  await browser.close();
}
