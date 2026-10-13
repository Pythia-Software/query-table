import assert from "node:assert/strict";
import { chromium } from "playwright";
import { decodeQuery, normalizeQueryState } from "../packages/core/dist/index.js";

const origin = new URL(process.env.QT_DEMO_URL ?? "http://localhost:5179").origin;
const marker = "query-table:grouping-library:migrated";
const prototypeKey = "query-table:grouping-prototype:v2";
const legacyKey = "query-table:grouping-prototype:v1";
const backupKey = `${prototypeKey}:unreadable-backup`;
const libraryKey = "query-table:saved:grouping-library-input";
const defaultKey = "query-table:default:grouping-library-input";
const source = normalizeQueryState({ select: [{ field: "platform" }], limit: 10 });
const shared = { version: 2, mode: "groups", keys: ["platform"], summaries: [], representative: null,
  input: source, result: source };
const valid = { id: "old", name: "Imported platforms", savedAt: 1, view: shared };
const incompatible = { id: "bad", name: "Two representatives", savedAt: 2, view: {
  ...shared, version: 1, summaries: [{ id: "latest", op: "latest", field: "id" }, { id: "longest", op: "longest", field: "id" }],
} };
const oldState = JSON.stringify({ items: [valid, incompatible], defaultId: "old" });
const existing = [{ id: "current", name: "Keep this view", savedAt: 3, query: normalizeQueryState({ select: [{ field: "worker" }], limit: 7 }) }];
const later = { ...valid, id: "later", name: "View after rejected entry", savedAt: 10 };
const fixtures = [
  { name: "incompatible prototype view", key: prototypeKey, raw: oldState, names: [valid.name] },
  { name: "corrupt legacy storage", key: legacyKey, raw: "{corrupt", names: ["Busy workers", "Duration by platform", "Individual runs"] },
  { name: "existing library views", key: legacyKey, raw: oldState, names: [existing[0].name], existing: true },
  { name: "completed migration", key: prototypeKey, raw: oldState, names: [existing[0].name], existing: true, migrated: true },
  ...[
    { name: "duplicate name", item: { ...valid, id: "duplicate", name: ` ${valid.name} ` } },
    { name: "blank name", item: { ...valid, id: "blank", name: "  " } },
    { name: "over-long name", item: { ...valid, id: "long", name: "x".repeat(201) } },
    { name: "invalid timestamp", item: { ...valid, id: "timestamp", name: "Bad timestamp", savedAt: "yesterday" } },
    { name: "missing timestamp", item: { ...valid, id: "timestamp", name: "Missing timestamp", savedAt: undefined } },
  ].flatMap(({ name, item }) => [false, true].map(rejectedDefault => ({
    name: `${name}${rejectedDefault ? " as default" : " before valid default"}`,
    key: prototypeKey,
    raw: JSON.stringify({ items: [valid, item, later], defaultId: rejectedDefault ? item.id : later.id }),
    names: [valid.name, later.name],
    defaultName: rejectedDefault ? null : later.name,
  }))),
];
const browser = await chromium.launch({ headless: true });
try {
  for (const fixture of fixtures) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [{ origin, localStorage: [
      { name: fixture.key, value: fixture.raw },
      ...(fixture.existing ? [{ name: libraryKey, value: JSON.stringify(existing) }, { name: defaultKey, value: "current" }] : []),
      ...(fixture.migrated ? [{ name: marker, value: "true" }, { name: backupKey, value: "original backup" }] : []),
    ] }] } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Record writes separately on each visit to catch redundant backups.
    await page.addInitScript(() => {
      window.__storageWrites = [];
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        window.__storageWrites.push(key);
        return set.call(this, key, value);
      };
    });
    try {
      await page.goto(`${origin}/grouping`);
      await page.waitForFunction(marker => localStorage.getItem(marker) === "true", marker);
      await page.waitForFunction(count => document.querySelectorAll('[aria-label="Saved views"] button').length === count, fixture.names.length);
      assert.deepEqual((await page.getByRole("navigation", { name: "Saved views" }).getByRole("button").allTextContents()).sort(), [...fixture.names].sort());
      const notice = page.locator("p.qt-group-notice[role=status]");
      assert.equal(await notice.count(), fixture.migrated ? 0 : 1, fixture.name);
      let saved = await page.evaluate(key => localStorage.getItem(key), libraryKey);
      const backup = await page.evaluate(key => localStorage.getItem(key), backupKey);
      assert.equal(backup, fixture.migrated ? "original backup" : fixture.raw);
      if (fixture.existing) assert.equal(saved, JSON.stringify(existing));
      if ("defaultName" in fixture) {
        const defaultId = await page.evaluate(key => localStorage.getItem(key), defaultKey);
        assert.equal(JSON.parse(saved).find(item => item.id === defaultId)?.name ?? null, fixture.defaultName);
      }

      // Exercise writes before navigating: a rejected import used to poison
      // every storage method for the rest of this browser visit.
      const limit = page.getByRole("spinbutton", { name: "limit", exact: true });
      await limit.fill("17");
      await limit.press("Enter");
      await page.waitForURL(url => decodeQuery(url.searchParams.get("q")).limit === 17);
      await page.getByRole("button", { name: "Save query", exact: true }).click();
      await page.locator(".qt-qb-saved-input").fill("Saved after import");
      await page.locator(".qt-qb-saved-input").press("Enter");
      await page.getByRole("navigation", { name: "Saved views" }).getByRole("button", { name: "Saved after import", exact: true }).waitFor();
      saved = await page.evaluate(key => localStorage.getItem(key), libraryKey);
      assert.deepEqual(JSON.parse(saved).find(item => item.name === "Saved after import").query,
        decodeQuery(new URL(page.url()).searchParams.get("q")));

      // Revisit without the generated ?q= so normal saved-default loading runs.
      await page.goto(`${origin}/grouping`);
      await page.getByRole("navigation", { name: "Saved views" }).getByRole("button").first().waitFor();
      assert.equal(await notice.count(), 0, `${fixture.name}: repeated notice`);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), fixture.key), fixture.raw);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), libraryKey), saved);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), backupKey), backup);
      assert.equal(await page.evaluate(key => window.__storageWrites.includes(key), backupKey), false);

      // Explicit old links still work after migration, independent of storage.
      await page.goto(`${origin}/grouping?view=${encodeURIComponent(JSON.stringify(shared))}`);
      await page.waitForURL(url => decodeQuery(url.searchParams.get("q")).grouping?.keys[0] === "platform");
      await page.getByRole("columnheader", { name: /Platform/ }).waitFor();
      assert.equal(await notice.count(), 0);
      await page.goto(`${origin}/grouping?view=${encodeURIComponent("{corrupt")}`);
      await notice.waitFor();
      assert.match(await notice.textContent(), /shared view could not be read/i);

      assert.deepEqual(errors, []);
      console.log(`Grouping migration passed: ${fixture.name}, repeat visit, preserved storage and legacy share links.`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
