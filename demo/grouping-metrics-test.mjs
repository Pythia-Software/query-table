import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { decodeQuery, encodeQuery, normalizeQueryState } from "../packages/core/dist/index.js";
// The npm script enables type stripping explicitly for Node 22.14–22.17.
import { RUNS } from "./src/data.ts";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
await mkdir(".context/grouping-metrics", { recursive: true });
const metric = (id, label, expression, scope = "allMatching") => ({
  id, label, expression, scope, op: "count", groupBy: [], display: { kind: "value" },
});
const initial = normalizeQueryState({
  grouping: {
    source: normalizeQueryState({
      select: [{ field: "platform" }, { field: "total_ms" }],
      where: [{ field: "total_ms", op: ">=", value: "20000" }],
      limit: 1, offset: 99,
      aggregations: [metric("source", "Source runs", "COUNT()")],
    }),
    keys: ["platform"], summaries: [{ id: "n", op: "count" }], representative: null,
  },
  select: [{ field: "platform" }, { field: "n" }], limit: 1,
  orderBy: [{ field: "n", dir: "desc" }, { field: "platform", dir: "asc" }],
  aggregations: [
    metric("all", "Matching groups", "COUNT()"), metric("runs", "Matching runs", "SUM([n])"),
    metric("page", "Shown groups", "COUNT()", "shownRows"), metric("page-runs", "Shown runs", "SUM([n])", "shownRows"),
  ],
});
const query = page => decodeQuery(new URL(page.url()).searchParams.get("q"));
const waitQuery = (page, predicate) => page.waitForURL(url => predicate(decodeQuery(url.searchParams.get("q"))));
// Deliberately independent of the library's filtering/grouping/metric engines.
function matches(row, term) {
  const value = row[term.field];
  if (value == null) return false;
  if (term.op === ">=") return value >= Number(term.value);
  if (term.op === "=") return String(value) === term.value;
  throw Error(`Unexpected test predicate: ${term.op}`);
}
function expected(q) {
  if (!q.grouping) return { cards: { "Source runs": RUNS.filter(row => q.where.every(term => matches(row, term))).length } };
  const groups = new Map();
  for (const row of RUNS.filter(row => q.grouping.source.where.every(term => matches(row, term))))
    groups.set(row.platform, (groups.get(row.platform) ?? 0) + 1);
  const matching = [...groups].map(([platform, n]) => ({ platform, n })).filter(row => q.where.every(term => matches(row, term)));
  matching.sort((a, b) => {
    for (const term of q.orderBy) {
      const cmp = typeof a[term.field] === "number" ? a[term.field] - b[term.field] : a[term.field].localeCompare(b[term.field]);
      if (cmp) return term.dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  const page = matching.slice(q.offset, q.offset + q.limit);
  return { rows: page, cards: Object.fromEntries(q.aggregations.map(c => {
    const population = c.scope === "shownRows" ? page : matching;
    const count = c.expression ? c.expression === "COUNT()" : c.op === "count";
    return [c.label, count ? population.length : population.length ? population.reduce((sum, row) => sum + row.n, 0) : null];
  })) };
}
async function check(page) {
  const wanted = expected(query(page));
  await page.waitForFunction(wanted => {
    const cards = Object.fromEntries([...document.querySelectorAll(".qt-metrics > .qt-metric")].map(card => [
      card.querySelector(".qt-metric-title")?.textContent,
      card.querySelector(".qt-metric-big-value")?.textContent?.replace(/,/g, ""),
    ]));
    return !document.querySelector(".qt-metric-loading") && Object.entries(wanted).every(([label, value]) => cards[label] === (value === null ? "—" : String(value)));
  }, wanted.cards);
  assert.deepEqual(await page.locator(".qt-metrics-error").allTextContents(), []);
  if (wanted.rows) {
    const actual = await page.locator(".qt-table tbody tr").evaluateAll(rows => rows.flatMap(row => {
      const cells = [...row.querySelectorAll("td")];
      return cells.length > 1 ? [{ platform: cells.at(-2).textContent.trim(), n: Number(cells.at(-1).textContent.trim()) }] : [];
    }));
    assert.deepEqual(actual, wanted.rows);
  }
}
async function number(page, label, value) {
  const input = page.getByLabel(new RegExp(`^${label}$`, "i"));
  await input.fill(String(value));
  await input.press("Enter");
  await waitQuery(page, q => ["limit", "offset"].includes(label)
    ? q[label] === value
    : q.where.some(term => term.field === "n" && term.value === String(value)));
  await check(page);
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1470, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(`${origin}/?q=${encodeQuery(initial)}`);
    await check(page);
    await page.getByRole("button", { name: "Add offset", exact: true }).click();
    await number(page, "offset", 1);
    await number(page, "offset", 99); // Empty page must not empty all-matching metrics.
    await number(page, "limit", 2);

    await page.getByRole("button", { name: "Add HAVING filter", exact: true }).click();
    await page.locator(".qt-picker-item").filter({ has: page.locator(".qt-picker-label", { hasText: /^Row count$/ }) }).click();
    const having = page.locator('[data-clause="having"]');
    await having.locator(".qt-op-trigger").click();
    await page.getByRole("menuitemradio", { name: "≥", exact: true }).click();
    await number(page, "value for Row count", 7);
    const source = page.locator('[data-clause="where"]');
    const sourceValue = source.locator("input").first();
    await sourceValue.fill("40000"); await sourceValue.press("Enter");
    await waitQuery(page, q => q.grouping?.source.where[0]?.value === "40000"); await check(page);
    await sourceValue.fill("20000"); await sourceValue.press("Enter");
    await waitQuery(page, q => q.grouping?.source.where[0]?.value === "20000"); await check(page);
    await number(page, "value for Row count", 999); // HAVING removes every group.
    await number(page, "value for Row count", 7);
    await number(page, "limit", 1);
    await page.screenshot({ path: `.context/grouping-metrics/${name}.png`, fullPage: true });

    // The metric editor must expose projected fields and preview its draft scope.
    await page.locator(".qt-metrics > .qt-metric").filter({ has: page.locator(".qt-metric-title", { hasText: /^Shown runs$/ }) }).hover();
    await page.getByRole("button", { name: "Edit metric Shown runs", exact: true }).click();
    const dialog = page.locator(".qt-metrics-editor");
    await dialog.getByRole("button", { name: "Basic", exact: true }).click();
    const fields = await dialog.getByLabel("Measure field", { exact: true }).locator("option").evaluateAll(options => options.map(o => o.value));
    assert.ok(fields.includes("n"));
    assert.ok(!fields.includes("total_ms"));
    const scope = dialog.locator("details").filter({ has: page.locator("summary", { hasText: /^Data scope/ }) });
    if ((await scope.getAttribute("open")) === null) await scope.locator("summary").click();
    await dialog.getByRole("button", { name: "All matching rows", exact: true }).click();
    await dialog.getByLabel("Metric name", { exact: true }).fill("Runs after HAVING");
    await dialog.locator(".qt-metric-preview-card .qt-metric-big-value").filter({ hasText: /^15$/ }).waitFor();
    await dialog.getByRole("button", { name: "Apply metrics", exact: true }).click();
    await waitQuery(page, q => q.aggregations?.find(c => c.id === "page-runs")?.scope === "allMatching");
    await check(page);

    await page.getByRole("button", { name: "Edit metrics", exact: true }).click();
    await dialog.locator(".qt-metric-library").getByRole("button", { name: "+ Create metric", exact: true }).click();
    await dialog.getByLabel("Metric name", { exact: true }).fill("Run total via editor");
    await dialog.getByLabel("Measure field", { exact: true }).selectOption("n");
    await dialog.getByLabel("Aggregation function", { exact: true }).selectOption("sum");
    await dialog.getByRole("button", { name: "Apply metrics", exact: true }).click();
    await waitQuery(page, q => q.aggregations?.some(c => c.label === "Run total via editor"));
    await check(page);
    await page.reload(); await check(page);
    const grouped = query(page);
    await page.getByRole("button", { name: "Remove Platform column", exact: true }).click();
    await waitQuery(page, q => !q.grouping);
    await check(page);
    assert.equal(query(page).grouping, undefined);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitQuery(page, q => Boolean(q.grouping));
    await check(page);
    assert.deepEqual(query(page), grouped);
    await page.screenshot({ path: `.context/grouping-metrics/${name}-edited.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`${name}: grouped metrics, both scopes, paging, WHERE/HAVING, empty populations, editor previews, creation, URL reload, mode restoration and undo passed.`);
  } catch (error) {
    await page.screenshot({ path: `.context/grouping-metrics/${name}-failure.png`, fullPage: true });
    console.error(await page.locator("body").innerText());
    throw error;
  } finally { await browser.close(); }
}
