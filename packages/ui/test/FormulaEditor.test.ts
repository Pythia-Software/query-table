// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileFormula,
  type FieldDef,
} from "@pythia-software/query-table-core";
import FormulaEditor from "../src/FormulaEditor";
import { formulaCompletions, signatureAt } from "../src/formulaEditorHelpers";
import { ModalSurface } from "../src/AdaptiveOverlay";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const fields: FieldDef[] = [
  { name: "job", label: "Job name", type: "text", source: { kind: "backend" } },
  {
    name: "a]b",
    label: "Escaped field",
    type: "text",
    source: { kind: "backend" },
  },
];
const compile = (value: string) => compileFormula(value, fields);
let root: Root;
let container: HTMLDivElement;
function mount(value = "", onClose?: () => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const [text, setText] = useState(value);
    const editor = createElement(FormulaEditor, {
      value: text,
      onChange: setText,
      fields,
      compile,
    });
    return onClose
      ? createElement(ModalSurface, {
          title: "Formula",
          onClose,
          children: editor,
        })
      : editor;
  }
  act(() => root.render(createElement(Harness)));
  const input = document.querySelector<HTMLTextAreaElement>(
    ".qt-formula-editor textarea",
  )!;
  act(() => {
    input.focus();
    input.setSelectionRange(value.length, value.length);
  });
  return input;
}
function key(input: HTMLElement, key: string, extras: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...extras,
  });
  act(() => input.dispatchEvent(event));
  return event;
}
function suggestions() {
  act(() =>
    (
      document.querySelector(".qt-formula-tools button") as HTMLButtonElement
    ).click(),
  );
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("formula completion context", () => {
  it("keeps a stable signature live region and described-by target before hints appear", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const props = {
      value: "",
      fields,
      compile,
      onChange: vi.fn(),
      suggestions: false,
    };
    act(() => root.render(createElement(FormulaEditor, props)));
    const input = container.querySelector("textarea")!;
    const hint = container.querySelector(".qt-formula-hint")!;
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(hint.textContent).toBe("");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(
      hint.id,
    );
    act(() =>
      root.render(
        createElement(FormulaEditor, {
          ...props,
          value: "ROUND(",
          suggestions: true,
        }),
      ),
    );
    act(() => {
      input.focus();
      input.setSelectionRange(6, 6);
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "End", bubbles: true }),
      );
    });
    expect(container.querySelector(".qt-formula-hint")).toBe(hint);
    expect(hint.textContent).toContain("ROUND");
  });
  it("replaces complete tokens and escaped field references around the caret", () => {
    const field = formulaCompletions("[a]]b]", 3, 3, fields, true)!;
    expect([field.from, field.to]).toEqual([0, 6]);
    expect(field.options[0]?.insert).toBe("[a]]b]");
    const fn = formulaCompletions("left([job])", 2, 2, fields)!;
    expect([fn.from, fn.to]).toEqual([0, 4]);
    expect(fn.options.find((option) => option.label === "LEFT")?.insert).toBe(
      "LEFT",
    );
  });
  it("does not consume a later field when completing an unclosed reference", () => {
    const value = "CONCAT([fi, [last])";
    const caret = value.indexOf(",");
    const result = formulaCompletions(value, caret, caret, [
      { ...fields[0]!, name: "first", label: "First" },
    ])!;
    expect(
      value.slice(0, result.from) +
        result.options[0]!.insert +
        value.slice(result.to),
    ).toBe("CONCAT([first], [last])");
  });
  it("suppresses suggestions in strings and searches field display labels", () => {
    expect(formulaCompletions('"LEFT', 5, 5, fields, true)).toBeNull();
    expect(formulaCompletions("[Esc", 4, 4, fields)?.options[0]?.insert).toBe(
      "[a]]b]",
    );
    expect(formulaCompletions("123", 3, 3, fields)).toBeNull();
  });
  it("tracks arguments through nested calls, strings, and escaped fields", () => {
    expect(signatureAt('IF(TRUE, CONCAT("(,", [a]]b]), ')).toContain(
      "Argument 3",
    );
    expect(signatureAt("LEFT([job], ")).toContain("Argument 2");
  });
});

describe("native FormulaEditor", () => {
  it("inserts a function via keyboard and positions the caret inside its parentheses", () => {
    const input = mount("lef");
    key(input, " ", { ctrlKey: true, code: "Space" });
    expect(container.querySelector('[role="option"]')?.textContent).toContain(
      "LEFT",
    );
    key(input, "Enter");
    expect(input.value).toBe("LEFT()");
    expect(input.selectionStart).toBe(5);
    expect(container.textContent).toContain("Argument 1");
  });
  it("inserts escaped fields with pointer selection and retains surrounding text", () => {
    const input = mount('CONCAT([Esc, "x")');
    act(() => input.setSelectionRange(11, 11));
    suggestions();
    const option = container.querySelector('[role="option"]') as HTMLElement;
    act(() => option.click());
    expect(input.value).toBe('CONCAT([a]]b], "x")');
  });
  it("preserves a sibling field when accepting a completion in an unclosed reference", () => {
    const input = mount("CONCAT([jo, [a]]b])");
    act(() => input.setSelectionRange(10, 10));
    suggestions();
    key(input, "Enter");
    expect(input.value).toBe("CONCAT([job], [a]]b])");
  });
  it("pairs parentheses, skips the closing parenthesis, and deletes an empty pair", () => {
    const input = mount("LEFT");
    key(input, "(");
    expect(input.value).toBe("LEFT()");
    expect(input.selectionStart).toBe(5);
    key(input, "Backspace");
    expect(input.value).toBe("LEFT");
    key(input, "(");
    key(input, ")");
    expect(input.value).toBe("LEFT()");
    expect(input.selectionStart).toBe(6);
  });
  it("only auto-closes before whitespace, closing delimiters, or the end", () => {
    const input = mount("TRIMUPPER([job])");
    act(() => input.setSelectionRange(4, 4));
    expect(key(input, "(").defaultPrevented).toBe(false);
    expect(key(input, '"').defaultPrevented).toBe(false);
    expect(input.value).toBe("TRIMUPPER([job])");
    act(() => input.setSelectionRange(15, 15));
    key(input, "(");
    expect(input.value).toBe("TRIMUPPER([job]())");
  });
  it("does not skip closing characters that were already in the expression", () => {
    const input = mount("UPPER([job])");
    act(() => input.setSelectionRange(11, 11));
    expect(key(input, ")").defaultPrevented).toBe(false);
    expect(input.selectionStart).toBe(11);
  });
  it("wraps selected text even before another expression", () => {
    const input = mount("[job]UPPER([job])");
    act(() => input.setSelectionRange(0, 5));
    key(input, "(");
    expect(input.value).toBe("([job])UPPER([job])");
    key(input, ")");
    expect(input.selectionStart).toBe(7);
  });
  it("keeps suggestions open when the list scrollbar receives mousedown", () => {
    const input = mount("");
    suggestions();
    const list = container.querySelector('[aria-label="Formula suggestions"]')!;
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => list.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(list.isConnected).toBe(true);
    act(() => list.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  });
  it("leaves composition keystrokes and Tab to the native textarea", () => {
    const input = mount("LE");
    suggestions();
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    act(() =>
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    key(input, "(", { isComposing: true });
    expect(input.value).toBe("LE");
    expect(
      document.querySelector('[aria-label="Formula suggestions"]'),
    ).toBeNull();
  });
  it("dismisses suggestions before the containing modal on Escape", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const close = vi.fn();
    const input = mount("LE", close);
    suggestions();
    key(input, "Escape");
    expect(
      document.querySelector('[aria-label="Formula suggestions"]'),
    ).toBeNull();
    expect(close).not.toHaveBeenCalled();
    key(input, "Escape");
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports compiler diagnostics and selects the actual error range", () => {
    vi.useFakeTimers();
    const input = mount("LEFT([missing], 2)");
    act(() => vi.advanceTimersByTime(250));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(
      /unknown.*field/i,
    );
    act(() =>
      (
        container.querySelector('[role="status"] button') as HTMLButtonElement
      ).click(),
    );
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe(
      "[missing]",
    );
    expect(document.activeElement).toBe(input);
  });
  it("keeps diagnostics stable when the host supplies a new compile callback", () => {
    vi.useFakeTimers();
    mount();
    const render = (compiler: typeof compile, value = "LEFT([missing], 2)") =>
      act(() =>
        root.render(
          createElement(FormulaEditor, {
            value,
            onChange() {},
            fields,
            compile: compiler,
          }),
        ),
      );
    const firstCompile = vi.fn(compile);
    render(firstCompile);
    act(() => vi.advanceTimersByTime(250));
    const input = container.querySelector("textarea")!;
    const error = container.querySelector('[role="status"]');
    const nextCompile = vi.fn(compile);
    render(nextCompile);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[role="status"]')).toBe(error);
    act(() => vi.advanceTimersByTime(250));
    expect(firstCompile).toHaveBeenCalledOnce();
    expect(nextCompile).not.toHaveBeenCalled();
    render(nextCompile, "LEFT([job], 2)");
    act(() => vi.advanceTimersByTime(250));
    expect(nextCompile).toHaveBeenCalledOnce();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
  it("searches the function library and inserts a keyboard-selected result", () => {
    const input = mount("");
    const search =
      container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "minimum");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      container
        .querySelector('.qt-function-list [role="option"]')
        ?.getAttribute("aria-label"),
    ).toBe("Insert LEAST");
    key(search, "Enter");
    expect(input.value).toBe("LEAST()");
    expect(input.selectionStart).toBe(6);
    expect(document.activeElement).toBe(input);
  });
  it("wraps the selected input without replacing the surrounding formula", () => {
    const input = mount('CONCAT("x", [job])');
    act(() => input.setSelectionRange(12, 17));
    const option = container.querySelector<HTMLButtonElement>(
      '[aria-label="Insert LOWER"]',
    )!;
    act(() => option.click());
    expect(input.value).toBe('CONCAT("x", LOWER([job]))');
    expect(input.value[input.selectionStart]).toBe(")");
  });
  it("updates the same textarea when a host replaces the expression", () => {
    mount();
    act(() =>
      root.render(
        createElement(FormulaEditor, {
          value: "LEFT([job], 2)",
          onChange() {},
          fields,
          compile,
        }),
      ),
    );
    const input = container.querySelector("textarea")!;
    act(() =>
      root.render(
        createElement(FormulaEditor, {
          value: "TRUE",
          onChange() {},
          fields,
          compile,
        }),
      ),
    );
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("TRUE");
  });
});
