// Start npm run demo first. QT_DEMO_URL can target a production preview too.
// Grouped rows open native Detail from their group identity: keys, summaries
// and link summaries, across paging and reloads, with focus returning.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { decodeQuery, encodeQuery } from "../packages/core/dist/index.js";

const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179/";
const screenshots = new URL("../.context/group-detail/", import.meta.url);
await mkdir(screenshots, { recursive: true });

for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 390]) {
      const where = `${engineName} ${width}px`;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(new URL("/fit-controls", origin).href);
      const groups = page.locator("[data-table=groups]");
      await groups.locator("a.qt-group-link").first().waitFor();
      const headers = (await groups.locator("thead th").allTextContents()).map(text => text.trim());
      assert.deepEqual(headers.slice(-3), ["Drill In", "Open", "Detail"], `${where}: Detail follows the link columns`);

      // Open, read and dismiss; focus returns to the opener.
      const opener = groups.getByRole("button", { name: "Open group agent harness review in modal", exact: true });
      await opener.scrollIntoViewIfNeeded();
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Group details" });
      await dialog.waitFor();
      const text = await dialog.innerText();
      for (const expected of ["Conversation", "agent harness review", "Row count", "Total Words", "Matching records", "Open conversation"])
        assert.ok(text.includes(expected), `${where}: group detail shows ${expected}`);
      await dialog.getByRole("link", { name: "Matching records" }).waitFor();
      for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
      assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), `${where}: focus stays in the dialog`);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.ok(await opener.evaluate(button => document.activeElement === button), `${where}: focus returns to the opener`);

      // An expanded group stays readable on the next page.
      const expand = groups.getByRole("button", { name: "Expand group agent harness review", exact: true });
      await expand.focus();
      await page.keyboard.press("Enter");
      await groups.getByRole("region", { name: /^Expanded group / }).waitFor();
      await groups.getByRole("button", { name: /next/i }).click();
      await groups.getByText("Expanded group is outside the current page.").waitFor();
      assert.ok((await groups.locator(".qt-item-expanded").innerText()).includes("agent harness review"), `${where}: paged-away group still shown`);

      // A reload restores an open group from the address bar.
      const query = decodeQuery(new URL(page.url()).searchParams.get("groups"));
      const active = query.itemDetails.active;
      const url = new URL(page.url());
      url.searchParams.set("groups", encodeQuery({ ...query, offset: 0, itemDetails: { ...query.itemDetails, active: { id: active.id, mode: "modal" } } }));
      await page.goto(url.href);
      await page.getByRole("dialog", { name: "Group details" }).getByText("agent harness review").first().waitFor();

      // A group missing from the population says so.
      url.searchParams.set("groups", encodeQuery({ ...query, offset: 0, itemDetails: { ...query.itemDetails, active: { id: '[["conversation","gone"]]', mode: "modal" } } }));
      await page.goto(url.href);
      await page.getByRole("dialog", { name: "Group details" }).getByText(/This group is unavailable/).waitFor();
      await page.screenshot({ path: new URL(`${engineName.toLowerCase()}-${width}.png`, screenshots).pathname });
      assert.deepEqual(errors, [], `${where}: no page errors`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
console.log("group detail checks passed");
