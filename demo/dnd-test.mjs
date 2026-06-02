// Headless drag-and-drop regression probe for the demo.
//
//   1. Start the demo:  npm run demo   (serves http://localhost:5179)
//   2. In another shell: node demo/dnd-test.mjs
//
// Native OS drag deadlocks headless Chromium, so each scenario dispatches a
// synthetic HTML5 dragstart -> dragover -> drop sequence (sharing one
// DataTransfer, exactly as the browser does) against the REAL React tree.
// The resulting column order is read from the table headers, which derive
// straight from query.select, so it is immune to transient drag-state in the
// QueryBuilder chips. Each scenario reloads first for a clean state.
import { chromium } from "playwright";

const URL = process.env.QT_DEMO_URL ?? "http://localhost:5179/";

const PAGE_HELPERS = () => {
  window.__qt = {
    raf: () => new Promise((r) => requestAnimationFrame(() => r())),
    makeDT() {
      const s = {};
      return {
        dropEffect: "none", effectAllowed: "all", types: [],
        setData(t, v) { s[t] = String(v); this.types = Object.keys(s); },
        getData(t) { return s[t] ?? ""; },
        setDragImage() {}, clearData() { for (const k of Object.keys(s)) delete s[k]; },
      };
    },
    fire(node, type, dt, clientX) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
      if (clientX != null) Object.defineProperty(ev, "clientX", { value: clientX, configurable: true });
      node.dispatchEvent(ev);
      return ev;
    },
    rightHalfX(node) { const r = node.getBoundingClientRect(); return r.left + r.width * 0.75; },
    row(kw) {
      return [...document.querySelectorAll(".qt-qb-row")].find(
        (r) => r.querySelector(".qt-qb-kw")?.textContent?.trim() === kw);
    },
    chipLabel(el) { return el.textContent.replace(/[⋮✕↑↓]|asc|desc|nulls|first|last|\d/g, "").trim(); },
    selectChips() { return [...(this.row("select")?.querySelectorAll(".qt-chip--col") ?? [])]; },
    headerCells() { return [...document.querySelectorAll("th.qt-th")].filter((t) => t.querySelector(".qt-th-label")); },
    headerOrder() { return this.headerCells().map((t) => t.querySelector(".qt-th-label").textContent.replace(/[↑↓\d\s]/g, "")); },
    byHeader(label) { return this.headerCells().find((t) => t.querySelector(".qt-th-label").textContent.trim() === label); },
    byChip(label) { return this.selectChips().find((c) => this.chipLabel(c) === label); },
    // dragged-column dim positions (header vs first body row), to prove the whole
    // column moves together, not just the header.
    headerDimIndex() { return this.headerCells().findIndex((t) => t.classList.contains("qt-th--dragging")); },
    firstRowDataCells() {
      const tr = document.querySelector("tbody tr");
      return tr ? [...tr.querySelectorAll("td.qt-cell")].filter((td) => !td.classList.contains("qt-checkbox-cell")) : [];
    },
    cellDimIndex() { return this.firstRowDataCells().findIndex((td) => td.classList.contains("qt-cell--dragging")); },
    hasClass(el, c) { return !!el && el.classList.contains(c); },
    // order-by sort chips
    sortChips() { return [...(this.row("order by")?.querySelectorAll(".qt-chip--sort") ?? [])]; },
    sortOrder() { return this.sortChips().map((c) => c.querySelector(".qt-chip-field")?.textContent?.trim()); },
    bySort(label) { return this.sortChips().find((c) => c.querySelector(".qt-chip-field")?.textContent?.trim() === label); },
    appendSortViaHeaderMenu(headerLabel) {
      this.byHeader(headerLabel).querySelector(".qt-th-label").click();
      return this.raf().then(() => {
        const item = [...document.querySelectorAll(".qt-cm-item")].find((b) => b.textContent.trim() === "Append Sort (Asc)");
        if (item) item.click();
        return this.raf();
      });
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
  // wait out the debounced client-side load so the body has real data rows
  await page.waitForFunction(() => {
    const tr = document.querySelector("tbody tr");
    return tr && !tr.querySelector(".qt-empty");
  }, { timeout: 5000 });
  await page.evaluate(() => window.__qt.raf());
  return page;
}

const results = [];
const record = (name, expected, actual, info) =>
  results.push({ name, pass: JSON.stringify(expected) === JSON.stringify(actual), expected, actual, info });

const browser = await chromium.launch();

// ── S1: SELECT chip — drag "Case" onto "Overall" (forward move) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    const before = qt.headerOrder();
    qt.fire(qt.byChip("Case"), "dragstart", dt);
    await qt.raf();
    const tgt = qt.byChip("Overall");
    qt.fire(tgt, "dragover", dt);
    await qt.raf();
    // preview = order implied by the live drop-slot the user sees before releasing
    const sel = qt.row("select");
    const nodes = [...sel.querySelectorAll(".qt-chip--col, .qt-chip-drop-slot")];
    const preview = nodes.map((n) => (n.classList.contains("qt-chip-drop-slot") ? "Case" : qt.chipLabel(n)));
    qt.fire(tgt, "drop", dt);
    await qt.raf();
    return { before, preview, after: qt.headerOrder() };
  });
  record("S1 select-chip forward move lands where the live slot previewed", r.preview, r.after,
    { before: r.before, previewedToUser: r.preview, actualResult: r.after });
  await page.close();
}

// ── S2: no dead drop zone — every element under the cursor accepts the drop ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    qt.fire(qt.byChip("Total"), "dragstart", dt);
    await qt.raf();
    // Every drop candidate rendered in the select row while dragging (chips and
    // any slot placeholder) must be a valid HTML5 drop target (dragover must
    // preventDefault), otherwise releasing there is a silent dead zone.
    const candidates = [...qt.row("select").querySelectorAll(".qt-chip--col, .qt-chip-drop-slot")];
    const accepted = candidates.map((n) => qt.fire(n, "dragover", dt).defaultPrevented);
    return { count: candidates.length, accepted, allAccept: accepted.every(Boolean) };
  });
  record("S2 every drop target in the select row accepts a drop (no dead zone)", true, r.allAccept,
    { note: "false => some position is a dead zone where releasing does nothing", perTarget: r.accepted });
  await page.close();
}

// ── S3: TABLE HEADER — drag "Case" onto "Overall", release on the header ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    const before = qt.headerOrder();
    qt.fire(qt.byHeader("Case"), "dragstart", dt);
    await qt.raf();
    const tgt = qt.byHeader("Overall");
    qt.fire(tgt, "dragover", dt);
    await qt.raf();
    const nodes = [...document.querySelectorAll("th.qt-th")].filter(
      (t) => t.querySelector(".qt-th-label") || t.classList.contains("qt-th-drop-slot"));
    const preview = nodes.map((t) =>
      t.classList.contains("qt-th-drop-slot") ? "Case" : t.querySelector(".qt-th-label").textContent.replace(/[↑↓\d\s]/g, ""));
    qt.fire(tgt, "drop", dt);
    await qt.raf();
    return { before, preview, after: qt.headerOrder() };
  });
  record("S3 header-drop lands where the live slot previewed", r.preview, r.after,
    { before: r.before, previewedToUser: r.preview, actualResult: r.after });
  await page.close();
}

// ── S4: dragged source must stay mounted (else Chromium aborts the native drag) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    const before = qt.headerOrder();
    const src = qt.byHeader("Case");
    qt.fire(src, "dragstart", dt);
    await qt.raf();
    return { before, draggedStaysMounted: document.contains(src), headersWhileDragging: qt.headerOrder() };
  });
  record("S4 dragged header stays in the DOM during the drag", true, r.draggedStaysMounted,
    { note: "false => native HTML5 drag is aborted by the browser, so drop never fires", headersWhileDragging: r.headersWhileDragging });
  await page.close();
}

// ── S5: SELECT chip — backward move (drag "★" onto "Platform") ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    const before = qt.headerOrder();
    qt.fire(qt.byChip("★"), "dragstart", dt);
    await qt.raf();
    const tgt = qt.byChip("Platform");
    qt.fire(tgt, "dragover", dt); // default clientX=0 => left half => insert before
    await qt.raf();
    const nodes = [...qt.row("select").querySelectorAll(".qt-chip--col")];
    const preview = nodes.map((n) => qt.chipLabel(n));
    qt.fire(tgt, "drop", dt);
    await qt.raf();
    return { before, preview, after: qt.headerOrder() };
  });
  record("S5 backward move lands where the preview showed", r.preview, r.after,
    { before: r.before });
  await page.close();
}

// ── S6: move a column to the LAST slot (drop past the last column's midpoint) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    const before = qt.headerOrder();
    qt.fire(qt.byChip("Case"), "dragstart", dt);
    await qt.raf();
    const last = qt.byChip("★");
    qt.fire(last, "dragover", dt, qt.rightHalfX(last)); // right half => insert AFTER => append
    await qt.raf();
    const nodes = [...qt.row("select").querySelectorAll(".qt-chip--col")];
    const preview = nodes.map((n) => qt.chipLabel(n));
    qt.fire(last, "drop", dt);
    await qt.raf();
    return { before, preview, after: qt.headerOrder() };
  });
  record("S6 a column can be dragged to the very last position", ["Platform", "Overall", "Total", "★", "Case"], r.after,
    { before: r.before, preview: r.preview });
  await page.close();
}

// ── S7: the whole column reorders during drag (body cells follow the header) ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    qt.fire(qt.byHeader("Case"), "dragstart", dt);
    await qt.raf();
    const tgt = qt.byHeader("Overall");
    qt.fire(tgt, "dragover", dt);
    await qt.raf();
    // While dragging: the dimmed header and the dimmed body cell must be at the
    // SAME column index — i.e. the body column moved with its header.
    return { headerDimIndex: qt.headerDimIndex(), cellDimIndex: qt.cellDimIndex(), headerOrder: qt.headerOrder() };
  });
  record("S7 body cells reorder with the header during drag (not just the header)",
    { headerDimIndex: r.headerDimIndex, sameColumn: true },
    { headerDimIndex: r.headerDimIndex, sameColumn: r.headerDimIndex === r.cellDimIndex && r.headerDimIndex >= 0 },
    { headerOrderWhileDragging: r.headerOrder, cellDimIndex: r.cellDimIndex });
  await page.close();
}

// ── S8: cross-surface — dragging a SELECT chip dims+reorders the table column ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    // drag the "Total" select chip and hover the "Platform" chip
    qt.fire(qt.byChip("Total"), "dragstart", dt);
    await qt.raf();
    qt.fire(qt.byChip("Platform"), "dragover", dt);
    await qt.raf();
    return {
      chipDimmed: qt.hasClass(qt.byChip("Total"), "qt-chip--dragging"),
      headerDimmed: qt.hasClass(qt.byHeader("Total"), "qt-th--dragging"),
      tableHeaderOrderWhileDraggingChip: qt.headerOrder(),
    };
  });
  // dragging the chip must dim BOTH the chip and the matching table column, and
  // live-reorder the table columns (Total slides before Platform).
  record("S8 dragging a select chip dims + live-reorders the matching table column",
    { chipDimmed: true, headerDimmed: true, tableReordered: ["Case", "Total", "Platform", "Overall", "★"] },
    { chipDimmed: r.chipDimmed, headerDimmed: r.headerDimmed, tableReordered: r.tableHeaderOrderWhileDraggingChip });
  await page.close();
}

// ── S8b: cross-surface the other way — dragging a HEADER dims the select chip ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    qt.fire(qt.byHeader("Platform"), "dragstart", dt);
    await qt.raf();
    return { chipDimmed: qt.hasClass(qt.byChip("Platform"), "qt-chip--dragging") };
  });
  record("S8b dragging a table header dims the matching select chip", true, r.chipDimmed);
  await page.close();
}

// ── S9: order-by chips — live preview + dimmed source, preview == result ──
{
  const page = await freshPage(browser);
  const r = await page.evaluate(async () => {
    const qt = window.__qt, dt = qt.makeDT();
    await qt.appendSortViaHeaderMenu("Platform"); // now 2 sort terms: Enqueued, Platform
    const before = qt.sortOrder();
    qt.fire(qt.bySort("Platform"), "dragstart", dt);
    await qt.raf();
    const dimmed = qt.hasClass(qt.bySort("Platform"), "qt-chip--dragging");
    const tgt = qt.bySort("Enqueued");
    qt.fire(tgt, "dragover", dt);
    await qt.raf();
    const preview = qt.sortOrder();
    qt.fire(tgt, "drop", dt);
    await qt.raf();
    return { before, dimmed, preview, after: qt.sortOrder() };
  });
  record("S9 order-by drag shows a dimmed source and preview == result",
    { dimmed: true, previewEqualsResult: true },
    { dimmed: r.dimmed, previewEqualsResult: JSON.stringify(r.preview) === JSON.stringify(r.after) },
    { before: r.before, preview: r.preview, after: r.after });
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
