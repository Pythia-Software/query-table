// Regression: ordinary consumers get grouping without importing demo components.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const origin = process.env.QT_DEMO_URL ?? "http://localhost:5179";
const browser = await chromium.launch({ headless: true });
const errors = [];
await mkdir(".context", { recursive: true });
try {
  for (const [route, key, groups, sourceCount] of [
    ["/", "Platform", 3, 40],
    ["/objects", "Status", 2, 2],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL(route, origin).toString());
    const table =
      route === "/objects"
        ? page.getByRole("region", { name: "Tool call collection" })
        : page;
    await table.locator(".qt-table tbody tr").first().waitFor();
    const expand = table.getByRole("button", {
      name: "Expand query builder",
      exact: true,
    });
    if (await expand.count()) await expand.click();
    const originalColumns = await table
      .locator(".qt-table th")
      .allTextContents();
    assert.equal(await table.locator(".qt-column-role-badge").count(), 0);
    await table
      .getByRole("button", { name: "Add group by", exact: true })
      .click();
    await page
      .locator(".qt-picker-item")
      .filter({
        has: page.locator(".qt-picker-label", {
          hasText: new RegExp(`^${key}$`),
        }),
      })
      .click();
    await page.waitForFunction(
      ({ count, objects }) =>
        document.querySelectorAll(
          `${objects ? ".qt-object-demo-collection " : ""}.qt-table tbody tr`,
        ).length === count,
      { count: groups, objects: route === "/objects" },
    );
    assert.equal(
      await table
        .locator(".qt-table th .qt-column-role-badge[data-column-role=key]")
        .count(),
      1,
    );
    await table
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    await page
      .locator(".qt-picker-item")
      .filter({
        has: page.locator(".qt-picker-label", { hasText: /^Row count$/ }),
      })
      .click();
    await table.getByRole("columnheader", { name: /Row count/ }).waitFor();
    await page
      .waitForFunction(
        ({ count, objects }) =>
          [
            ...document.querySelectorAll(
              `${objects ? ".qt-object-demo-collection " : ""}.qt-table tbody tr`,
            ),
          ].reduce(
            (sum, row) =>
              sum + Number(row.querySelector("td:last-child")?.textContent),
            0,
          ) === count,
        { count: sourceCount, objects: route === "/objects" },
      )
      .catch(async (error) => {
        console.log(route, await table.innerText());
        throw error;
      });
    await table
      .getByRole("button", { name: "Customize columns", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Select columns", exact: true })
      .waitFor();
    await page
      .getByRole("group", { name: "Visible column panels", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Close column editor", exact: true })
      .click();
    await page.screenshot({
      path: `.context/library-grouping${route === "/" ? "-runs" : "-objects"}.png`,
      fullPage: true,
    });
    const shared = page.url();
    const fresh = await browser.newPage();
    fresh.on("pageerror", (error) => errors.push(error.message));
    await fresh.goto(shared);
    await fresh.getByRole("columnheader", { name: /Row count/ }).waitFor();
    await fresh.close();
    await table
      .getByRole("button", { name: `Remove ${key} column`, exact: true })
      .click();
    await page.waitForFunction(
      ({ objects, headers }) =>
        JSON.stringify(
          [
            ...document.querySelectorAll(
              `${objects ? ".qt-object-demo-collection " : ""}.qt-table th`,
            ),
          ].map((el) => el.textContent),
        ) === JSON.stringify(headers),
      { objects: route === "/objects", headers: originalColumns },
    );
    assert.equal(
      await table.locator(".qt-table .qt-column-role-badge").count(),
      0,
    );
    if (route === "/objects") {
      // The independent record inspector survives both result modes.
      await page
        .getByRole("region", { name: "Tool call item" })
        .getByRole("button", { name: "Customize properties", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Edit properties", exact: true })
        .waitFor();
    }
    await page.close();
  }
  const ungrouped = await browser.newPage();
  ungrouped.on("pageerror", error => errors.push(error.message));
  const ungroupedUrl = new URL("/grouping", origin);
  ungroupedUrl.searchParams.set("q", Buffer.from(JSON.stringify({ s: [["platform"]], l: 3, b: null })).toString("base64url"));
  await ungrouped.goto(ungroupedUrl.toString());
  await ungrouped.waitForFunction(() => document.querySelectorAll(".qt-table tbody tr").length === 3);
  assert.equal(await ungrouped.locator(".qt-column-role-badge").count(), 0);
  await ungrouped.getByRole("button", { name: "Add group by", exact: true }).waitFor();
  await ungrouped.close();
  assert.deepEqual(errors, []);
  console.log(
    "Standard grouping integration passed: both catalogues, full rows, shared editor, URL reload, and record restoration.",
  );
} finally {
  await browser.close();
}
