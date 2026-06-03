// Headless probe for the aggregation metrics add-on.
//
//   1. Start the demo:  npm run demo   (serves http://localhost:5179)
//   2. In another shell: node demo/metrics-test.mjs
//
// Drives the real React tree: builds metrics via the QueryBuilder "metrics" row
// and reads the MetricsPanel above the table. The demo runs in clientRows mode,
// so this also exercises core's applyAggregations end-to-end. Synthetic HTML5
// drag (shared DataTransfer) is used for the reorder check, like dnd-test.mjs.
import { chromium } from "playwright";

const URL = process.env.QT_DEMO_URL ?? "http://localhost:5179/";

const PAGE_HELPERS = () => {
  window.__qt = {
    raf: () => new Promise((r) => requestAnimationFrame(() => r())),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    makeDT() {
      const s = {};
      return {
        dropEffect: "none",
        effectAllowed: "all",
        types: [],
        setData(t, v) {
          s[t] = String(v);
          this.types = Object.keys(s);
        },
        getData(t) {
          return s[t] ?? "";
        },
        setDragImage() {},
        clearData() {
          for (const k of Object.keys(s)) delete s[k];
        },
      };
    },
    fire(node, type, dt, clientX) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
      if (clientX != null) Object.defineProperty(ev, "clientX", { value: clientX, configurable: true });
      node.dispatchEvent(ev);
      return ev;
    },
    row(kw) {
      return [...document.querySelectorAll(".qt-qb-row")].find(
        (r) => r.querySelector(".qt-qb-kw")?.textContent?.trim() === kw,
      );
    },
    metricsRow() {
      return this.row("metrics");
    },
    addMetric() {
      const btn = [...this.metricsRow().querySelectorAll(".qt-add")].find((b) => b.textContent.includes("add metric"));
      btn.click();
      return this.raf();
    },
    aggChips() {
      return [...(this.metricsRow()?.querySelectorAll(".qt-chip--agg") ?? [])];
    },
    opOrder() {
      return this.aggChips().map((c) => c.querySelector("select")?.value);
    },
    setSelect(sel, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    },
    setMeasure(chip, label) {
      const sel = chip.querySelectorAll("select")[1];
      const opt = [...sel.options].find((o) => o.textContent.trim() === label);
      if (opt) this.setSelect(sel, opt.value);
    },
    addGroup(chip, label) {
      const addBtn = [...chip.querySelectorAll("button")].find((b) => /^\+( by)?$/.test(b.textContent.trim()));
      addBtn.click();
      return this.raf().then(() => {
        const item = [...document.querySelectorAll(".qt-picker-item")].find(
          (b) => b.querySelector(".qt-picker-label")?.textContent?.trim() === label,
        );
        item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return this.raf();
      });
    },
    panelBigValue() {
      const el = document.querySelector(".qt-metric-big-value");
      return el ? el.textContent.trim() : null;
    },
    barValues() {
      return [...document.querySelectorAll(".qt-metric-bar-value")].map((e) => e.textContent.trim());
    },
    pivotPresent() {
      return !!document.querySelector(".qt-metric-pivot");
    },
    totalRows() {
      const el = [...document.querySelectorAll(".qt-qb-run-metric")].find((s) => /rows/.test(s.textContent));
      const m = el?.textContent?.match(/of\s+(\d+)/);
      return m ? Number(m[1]) : null;
    },
  };
};

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.addInitScript(PAGE_HELPERS);
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await page.waitForSelector("th.qt-th");
  await page.waitForFunction(
    () => {
      const tr = document.querySelector("tbody tr");
      return tr && !tr.querySelector(".qt-empty");
    },
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__qt.raf());
  return page;
}

const results = [];
const record = (name, expected, actual, info) =>
  results.push({ name, pass: JSON.stringify(expected) === JSON.stringify(actual), expected, actual, info });

const browser = await chromium.launch();

// ── M1: "+ add metric" → a count(*) big number = total rows ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    const total = qt.totalRows();
    await qt.addMetric();
    await qt.delay(400);
    return { chipCount: qt.aggChips().length, big: qt.panelBigValue(), total };
  });
  record("M1 add metric renders a count(*) big number equal to total rows", { chipCount: 1, big: String(r.total) }, { chipCount: r.chipCount, big: r.big }, r);
  await page.close();
}

// ── M2: avg(total_ms) by platform → ranked bars ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric();
    await qt.delay(50);
    const chip = qt.aggChips()[0];
    qt.setSelect(chip.querySelector("select"), "avg");
    await qt.raf();
    qt.setMeasure(chip, "Total");
    await qt.raf();
    await qt.addGroup(chip, "Platform");
    await qt.delay(400);
    return { bars: qt.barValues().length, measureValue: chip.querySelectorAll("select")[1].value };
  });
  record("M2 avg(total_ms) by platform renders a ranked bar list (≥1 bar)", { measureValue: "total_ms", hasBars: true }, { measureValue: r.measureValue, hasBars: r.bars >= 1 }, r);
  await page.close();
}

// ── M3: two group-bys → 2-axis pivot ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric();
    await qt.delay(50);
    const chip = qt.aggChips()[0];
    await qt.addGroup(chip, "Platform");
    await qt.addGroup(chip, "Overall");
    await qt.delay(400);
    return { pivot: qt.pivotPresent() };
  });
  record("M3 two group-bys render an x/y pivot table", { pivot: true }, { pivot: r.pivot }, r);
  await page.close();
}

// ── M4: a metric with no group shows a single "+ by" button (not "by (total)") ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric();
    await qt.raf();
    const chip = qt.aggChips()[0];
    const hasByBtn = [...chip.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ by");
    const hasTotalHint = chip.textContent.includes("(total)");
    return { hasByBtn, hasTotalHint };
  });
  record("M4 no-group metric shows a '+ by' button and no '(total)' filler", { hasByBtn: true, hasTotalHint: false }, r, r);
  await page.close();
}

// ── M5: metric chips are draggable to reorder (drag B before A) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric(); // A: count
    await qt.delay(30);
    await qt.addMetric(); // B: count → change to avg(Total) so the two are distinguishable
    await qt.delay(30);
    const chipB = qt.aggChips()[1];
    qt.setSelect(chipB.querySelector("select"), "avg");
    await qt.raf();
    qt.setMeasure(chipB, "Total");
    await qt.raf();
    const before = qt.opOrder();
    // drag chip B onto chip A (clientX 0 ⇒ left half ⇒ insert before A)
    const chips = qt.aggChips();
    const dt = qt.makeDT();
    qt.fire(chips[1], "dragstart", dt);
    await qt.raf();
    qt.fire(chips[0], "dragover", dt);
    await qt.raf();
    qt.fire(chips[0], "drop", dt);
    await qt.raf();
    return { before, after: qt.opOrder() };
  });
  record("M5 dragging a metric chip reorders the metrics list", { before: ["count", "avg"], after: ["avg", "count"] }, r, r);
  await page.close();
}

// ── M6: numeric values share one bounded decimal count (~5 sig figs) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric();
    await qt.delay(30);
    const chip = qt.aggChips()[0];
    qt.setSelect(chip.querySelector("select"), "avg");
    await qt.raf();
    qt.setMeasure(chip, "Run"); // id: a number field with no unit renderer → plain formatNumber
    await qt.raf();
    await qt.addGroup(chip, "Platform");
    await qt.delay(400);
    const vals = qt.barValues().map((v) => v.replace(/,/g, ""));
    const decimalsOf = (s) => (s.includes(".") ? s.split(".")[1].length : 0);
    const counts = [...new Set(vals.map(decimalsOf))];
    const maxDecimals = Math.max(...vals.map(decimalsOf), 0);
    return { vals, consistent: counts.length === 1, bounded: maxDecimals <= 4 };
  });
  record("M6 avg(id) by platform: all values share one decimal count, ≤4 places", { consistent: true, bounded: true }, { consistent: r.consistent, bounded: r.bounded }, r);
  await page.close();
}

// ── M7: panel is a grey tray (white cards) + dotted separator above the row ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt;
    await qt.addMetric();
    await qt.delay(200);
    const panelBg = getComputedStyle(document.querySelector(".qt-metrics")).backgroundColor;
    const cardBg = getComputedStyle(document.querySelector(".qt-metric")).backgroundColor;
    const sep = getComputedStyle(qt.metricsRow()).borderTopStyle;
    return { panelBg, cardBg, sep };
  });
  record(
    "M7 metrics panel is grey, cards white, with a dotted separator",
    { greyTray: true, whiteCards: true, dottedSep: true },
    {
      greyTray: r.panelBg === "rgb(246, 248, 250)",
      whiteCards: r.cardBg === "rgb(255, 255, 255)",
      dottedSep: r.sep === "dotted",
    },
    r,
  );
  await page.close();
}

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`\n[${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`   expected: ${JSON.stringify(r.expected)}`);
  console.log(`   actual:   ${JSON.stringify(r.actual)}`);
  if (r.info) console.log(`   info:     ${JSON.stringify(r.info)}`);
}
console.log(`\n${results.length - failed}/${results.length} passed; ${failed} failed.`);
process.exit(failed ? 1 : 0);
