// Start npm run demo first. QT_DEMO_URL can target a production preview.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

for (const [name, engine] of [
  ["Chromium", chromium],
  ["WebKit", webkit],
]) {
  // Chromium hides scrollbars by default in headless runs; retain them to test dragging.
  const browser = await engine.launch({
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.QT_DEMO_URL ?? "http://localhost:5179/");
    await page
      .getByRole("button", { name: "Customize columns", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Computed column", exact: true })
      .click();
    const editor = page.getByRole("textbox", {
      name: "Computed column formula",
      exact: true,
    });
    await page.locator(".qt-formula-input").waitFor();
    await editor.fill("lef");
    await editor.press("Control+Space");
    await page.getByRole("listbox", { name: "Formula suggestions" }).waitFor();
    await editor.press("Enter");
    assert.equal(await editor.inputValue(), "LEFT()", `${name}: completion`);
    assert.equal(await editor.evaluate((input) => input.selectionStart), 5);
    await editor.press("ControlOrMeta+z");
    // Browsers may group the prefix edit and completion into one undo step.
    assert.notEqual(
      await editor.inputValue(),
      "LEFT()",
      `${name}: suggestion participates in native undo`,
    );
    await editor.press("ControlOrMeta+Shift+z");
    assert.equal(await editor.inputValue(), "LEFT()", `${name}: native redo`);

    await editor.fill("");
    await editor.press("(");
    assert.equal(await editor.inputValue(), "()");
    await editor.press("Backspace");
    assert.equal(await editor.inputValue(), "");
    await editor.press('"');
    assert.equal(await editor.inputValue(), '""');
    await page.keyboard.insertText("hello");
    await editor.press('"');
    assert.equal(await editor.inputValue(), '"hello"');

    await editor.fill("CONCAT([job_n, [platform])");
    await editor.evaluate((input) => input.setSelectionRange(13, 13));
    await editor.press("Control+Space");
    await editor.press("Enter");
    assert.equal(
      await editor.inputValue(),
      "CONCAT([job_name], [platform])",
      `${name}: incomplete field completion preserves the next argument`,
    );

    await editor.fill("UPPER([job_name])");
    await editor.evaluate((input) => input.setSelectionRange(0, 0));
    await editor.pressSequentially("TRIM(");
    assert.equal(
      await editor.inputValue(),
      "TRIM(UPPER([job_name])",
      `${name}: no generated closer before existing text`,
    );
    await editor.fill("UPPER([job_name])");
    await editor.evaluate((input) => input.setSelectionRange(0, 0));
    await editor.press('"');
    assert.equal(
      await editor.inputValue(),
      '"UPPER([job_name])',
      `${name}: no generated quote before existing text`,
    );
    await editor.fill("UPPER([job_name])");
    await editor.evaluate((input) => {
      const end = input.value.indexOf(")");
      input.setSelectionRange(end, end);
    });
    await editor.press(")");
    assert.equal(
      await editor.inputValue(),
      "UPPER([job_name]))",
      `${name}: manually supplied closer is editable`,
    );

    await editor.fill("");
    await editor.press("(");
    await page.keyboard.insertText("[job_name]");
    await editor.press(")");
    assert.equal(
      await editor.inputValue(),
      "([job_name])",
      `${name}: generated closer follows native text edits`,
    );
    await editor.fill("");
    await editor.press("(");
    await editor.evaluate((input) => input.setSelectionRange(0, 0));
    await editor.press("Delete");
    await editor.press(")");
    assert.equal(
      await editor.inputValue(),
      "))",
      `${name}: deleting the opener ends generated pair tracking`,
    );

    await editor.fill("");
    await editor.press("Control+Space");
    const suggestions = page.getByRole("listbox", {
      name: "Formula suggestions",
    });
    await suggestions.waitFor();
    await page.addStyleTag({
      content:
        ".qt-formula-completions ul::-webkit-scrollbar { width: 14px; } .qt-formula-completions ul::-webkit-scrollbar-thumb { background: #888; }",
    });
    const listBounds = await suggestions.boundingBox();
    assert.ok(listBounds);
    if (
      await suggestions.evaluate((list) => list.offsetWidth > list.clientWidth)
    ) {
      await page.mouse.move(
        listBounds.x + listBounds.width - 7,
        listBounds.y + 12,
      );
      await page.mouse.down();
      await page.mouse.move(
        listBounds.x + listBounds.width - 7,
        listBounds.y + 120,
        { steps: 8 },
      );
      await page.mouse.up();
    } else {
      // Headless WebKit exposes no scrollbar gutter. Exercise list focus retention
      // and native scrolling; Chromium above covers the actual thumb drag.
      await suggestions.dispatchEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      await suggestions.dispatchEvent("mouseup", { bubbles: true });
      await suggestions.hover();
      await page.mouse.wheel(0, 240);
    }
    await page.waitForFunction(
      () => document.querySelector(".qt-formula-completions ul")?.scrollTop > 0,
    );
    assert.equal(
      await suggestions.count(),
      1,
      `${name}: scrollbar drag keeps suggestions open`,
    );
    assert.equal(
      await editor.evaluate((input) => document.activeElement === input),
      true,
    );
    assert.ok(
      await suggestions.evaluate((list) => list.scrollTop > 0),
      `${name}: suggestion scrollbar scrolls`,
    );
    await editor.press("Escape");

    await editor.fill("[job_n");
    await page.getByRole("listbox", { name: "Formula suggestions" }).waitFor();
    await editor.press("Enter");
    assert.equal(
      await editor.inputValue(),
      "[job_name]",
      `${name}: automatic field completion`,
    );
    await editor.fill("LEFT([job_name], 3)");
    await editor.press("ControlOrMeta+a");
    await editor.press("ArrowRight");
    await editor.press("ArrowLeft");
    await page.waitForFunction(() =>
      document
        .querySelector(".qt-formula-hint")
        ?.textContent.includes("Argument 2"),
    );
    assert.match(
      await page.locator(".qt-formula-hint").innerText(),
      /Argument 2/,
    );
    await editor.fill("LEFT([missing], 3)");
    await page
      .getByRole("button", { name: "Select error location", exact: true })
      .click();
    assert.equal(
      await editor.evaluate((input) =>
        input.value.slice(input.selectionStart, input.selectionEnd),
      ),
      "[missing]",
    );

    const diagnostic = page.locator(".qt-formula-editor .qt-formula-error");
    await diagnostic.evaluate((error) => {
      window.formulaDiagnosticChanges = [];
      window.formulaDiagnosticObserver = new MutationObserver((records) =>
        window.formulaDiagnosticChanges.push(
          ...records
            .filter(
              (record) =>
                error.contains(record.target) ||
                record.attributeName === "aria-invalid" ||
                [...record.addedNodes, ...record.removedNodes].includes(error),
            )
            .map((record) => record.type),
        ),
      );
      window.formulaDiagnosticObserver.observe(error.parentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-invalid"],
      });
    });
    await page
      .getByRole("textbox", { name: "Column name", exact: true })
      .pressSequentially("My invalid column");
    assert.equal(
      await editor.getAttribute("aria-invalid"),
      "true",
      `${name}: label editing retains invalid state`,
    );
    assert.equal(await diagnostic.count(), 1);
    assert.deepEqual(
      await page.evaluate(() => window.formulaDiagnosticChanges),
      [],
      `${name}: label editing does not recreate or re-announce diagnostics`,
    );
    await page.evaluate(() => window.formulaDiagnosticObserver.disconnect());

    const library = page.getByRole("complementary", {
      name: "Function library",
    });
    const search = library.getByRole("combobox", { name: "Search functions" });
    const results = library.getByRole("listbox", {
      name: "Function library results",
    });
    const editorBounds = await editor.boundingBox();
    const libraryBounds = await library.boundingBox();
    assert.ok(
      editorBounds &&
        libraryBounds &&
        libraryBounds.x >= editorBounds.x + editorBounds.width,
      `${name}: function library is beside the editor`,
    );
    await search.focus();
    const workbenchScroll = await page
      .locator(".qt-column-workbench")
      .evaluate((element) => element.scrollTop);
    const assertLibrarySelectionVisible = async () => {
      await page.waitForFunction(
        () => {
          const list = document.querySelector(".qt-function-list");
          const option = list?.querySelector('[aria-selected="true"]');
          if (!list || !option) return false;
          const bounds = list.getBoundingClientRect();
          const selected = option.getBoundingClientRect();
          const top = bounds.top + list.clientTop;
          return (
            selected.top >= top - 1 &&
            selected.bottom <= top + list.clientHeight + 1
          );
        },
        undefined,
        { timeout: 2000 },
      );
      assert.equal(
        await page
          .locator(".qt-column-workbench")
          .evaluate((element) => element.scrollTop),
        workbenchScroll,
        `${name}: library navigation scrolls only its own list`,
      );
    };
    for (let i = 0; i < 15; i++) {
      await search.press("ArrowDown");
      await assertLibrarySelectionVisible();
    }
    for (let i = 0; i < 15; i++) {
      await search.press("ArrowUp");
      await assertLibrarySelectionVisible();
    }
    // Wrapping from the first result to the last and back must also reveal it.
    await search.press("ArrowUp");
    await assertLibrarySelectionVisible();
    await search.press("ArrowDown");
    await assertLibrarySelectionVisible();

    await editor.fill("");
    await search.fill("minimum");
    await search.press("Enter");
    assert.equal(
      await editor.inputValue(),
      "LEAST()",
      `${name}: search finds a function by concept`,
    );
    await editor.fill("[job_name]");
    await editor.press("ControlOrMeta+a");
    await search.fill("uppercase");
    await search.press("Enter");
    assert.equal(
      await editor.inputValue(),
      "UPPER([job_name])",
      `${name}: search preserves and wraps selected text`,
    );
    await search.fill("");
    await library
      .getByRole("combobox", { name: "Browse by concept", exact: true })
      .selectOption("strings");
    await library
      .getByRole("combobox", { name: "Return type", exact: true })
      .selectOption("number");
    assert.equal(await results.getByRole("option").count(), 1);
    assert.equal(
      await results.getByRole("option").getAttribute("aria-label"),
      "Insert LENGTH",
    );
    await search.fill("not-a-function");
    await library.getByText("No functions match.", { exact: false }).waitFor();
    await search.fill("");
    await library
      .getByRole("combobox", { name: "Browse by concept", exact: true })
      .selectOption("all");
    await library
      .getByRole("combobox", { name: "Return type", exact: true })
      .selectOption("all");

    // The suggestions button also works without a desktop keyboard shortcut.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".qt-sheet .qt-formula-input").waitFor();
    await editor.fill("COA");
    await page
      .getByRole("button", { name: "Suggestions", exact: true })
      .click();
    await page
      .getByRole("listbox", { name: "Formula suggestions" })
      .getByRole("option")
      .click();
    assert.equal(await editor.inputValue(), "COALESCE()");
    await editor.fill("LE");
    await page
      .getByRole("button", { name: "Suggestions", exact: true })
      .click();
    await editor.press("Escape");
    assert.equal(
      await page.getByRole("listbox", { name: "Formula suggestions" }).count(),
      0,
    );
    assert.equal(
      await editor.isVisible(),
      true,
      `${name}: Escape dismisses suggestions before the sheet`,
    );
    await editor.fill("LEFT([job_name], 3)");
    await page.locator(".qt-preview-summary").waitFor();
    const stackedLibrary = await library.boundingBox();
    const bounds = await editor.boundingBox();
    assert.ok(
      bounds && stackedLibrary && stackedLibrary.y >= bounds.y + bounds.height,
      `${name}: function library wraps below on mobile`,
    );
    await search.fill("prefix");
    await editor.evaluate((input) =>
      input.setSelectionRange(0, input.value.length),
    );
    await results
      .getByRole("option", { name: "Insert LEFT", exact: true })
      .click();
    assert.equal(
      await editor.inputValue(),
      "LEFT(LEFT([job_name], 3))",
      `${name}: mobile library insertion`,
    );
    assert.ok(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391,
      `${name}: mobile textarea fits`,
    );
    assert.deepEqual(errors, [], `${name}: no page errors`);
    console.log(
      `${name}: native completion, undo/redo, pairs, diagnostics, preview and mobile interactions passed`,
    );
  } finally {
    await browser.close();
  }
}
