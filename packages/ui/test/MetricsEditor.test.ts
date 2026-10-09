// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AggregationClause,
  FieldDef,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { MetricsEditor } from "../src/MetricsEditor";
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());
function editInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function commitInput(input: HTMLInputElement) {
  act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

it("allows Apply on controllers without optional preview or replace methods", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const setQuery = vi.fn(),
    onClose = vi.fn();
  const clause: AggregationClause = {
    id: "m",
    op: "count",
    groupBy: [],
    label: "Old",
  };
  const api = {
    aggregations: { clauses: [clause] },
    setQuery,
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(createElement(MetricsEditor, { api, fields: [], onClose })),
    );
    editInput(host.querySelector('[aria-label="Metric name"]')!, "New");
    const apply = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Apply metrics",
    )!;
    expect(apply.disabled).toBe(false);
    act(() => apply.click());
    expect(setQuery).toHaveBeenCalledOnce();
    expect(setQuery.mock.calls[0]![0]({ where: [] }).aggregations).toEqual([
      expect.objectContaining({ label: "New" }),
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("preserves intermediate numeric and name typing and commits bounded sizes and histogram bins on blur", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    replace = vi.fn();
  const clause: AggregationClause = {
    id: "m",
    op: "count",
    groupBy: [],
    display: { kind: "histogram" },
    distribution: { kind: "histogram", input: "[x]", bins: 10 },
    layout: { widthRem: 20, heightRem: 6, minWidthRem: 1, minHeightRem: 1 },
  };
  const preview = vi.fn(async () => ({
    metrics: [{ id: "m", buckets: [{ keys: [], count: 1234, value: 1234 }] }],
  }));
  const api = {
    aggregations: { clauses: [clause], preview, replace },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  const input = (label: string) =>
    host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, {
          api,
          fields: [
            {
              name: "x",
              label: "X",
              type: "number",
              source: { kind: "backend" },
            },
          ],
          onClose: vi.fn(),
          initialView: "dashboard",
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    const name = input("Layout metric name");
    editInput(name, "");
    expect(name.value).toBe("");
    editInput(name, "New name");
    expect(name.value).toBe("New name");
    for (const [label, values] of [
      ["Canvas width", ["", "1", "10", "100", "1000"]],
      ["Width in rem", ["", "3", "30"]],
    ] as const) {
      const field = input(label);
      for (const value of values) {
        editInput(field, value);
        expect(field.value).toBe(value);
      }
      commitInput(field);
      expect(field.value).toBe(values[values.length - 1]);
    }
    editInput(input("Min height in rem"), "12");
    commitInput(input("Min height in rem"));
    expect(input("Height in rem").value).toBe("12");
    const view = host.querySelector<HTMLSelectElement>(
      '[aria-label="Workbench view"]',
    )!;
    act(() => {
      view.value = "editor";
      view.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const value of ["", "1", "19"]) {
      editInput(input("Histogram bins"), value);
      expect(input("Histogram bins").value).toBe(value);
    }
    commitInput(input("Histogram bins"));
    const display = host.querySelector<HTMLSelectElement>(
      '[aria-label="Metric display"]',
    )!;
    act(() => {
      display.value = "value";
      display.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(input("Metric decimals").value).toBe("0");
    editInput(input("Metric decimals"), "1");
    commitInput(input("Metric decimals"));
    expect(input("Metric decimals").value).toBe("1");
    act(() =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Apply metrics")!
        .click(),
    );
    expect(replace.mock.calls[0]![0][0]).toMatchObject({
      label: "New name",
      layout: { widthRem: 30, heightRem: 12, minHeightRem: 12 },
      distribution: { bins: 19 },
      display: { format: { decimals: 1 } },
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("attaches preview resizing after first creation and after removing the last metric", async () => {
  const observers: Array<{ callback: () => void; targets: Element[] }> = [];
  class Observer {
    targets: Element[] = [];
    constructor(public callback: () => void) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
    unobserve(target: Element) {
      this.targets = this.targets.filter((t) => t !== target);
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const api = {
    aggregations: { clauses: [] },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, { api, fields: [], onClose: vi.fn() }),
      ),
    );
    for (let i = 0; i < 2; i++) {
      act(() =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent?.includes("Create metric"))!
          .click(),
      );
      const preview = host.querySelector<HTMLElement>(
        ".qt-metric-preview-card",
      )!;
      Object.defineProperty(preview, "offsetWidth", { value: 420 });
      Object.defineProperty(preview, "offsetHeight", { value: 250 });
      const observer = observers.find((o) => o.targets.includes(preview));
      expect(observer).toBeDefined();
      act(() => observer!.callback());
      expect(
        host.querySelector<HTMLInputElement>('[aria-label="Preview width"]')!
          .value,
      ).toBe("420");
      expect(
        host.querySelector<HTMLInputElement>('[aria-label="Preview height"]')!
          .value,
      ).toBe("250");
      act(() =>
        [
          ...host.querySelectorAll<HTMLButtonElement>(
            ".qt-metric-library button",
          ),
        ]
          .find((b) => b.textContent === "Remove")!
          .click(),
      );
      expect(observer!.targets).toHaveLength(0);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
it.each(["box", "histogram"] as const)(
  "clears incompatible sorts when switching a %s metric to scalar and scatter displays",
  async (kind) => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const commonSort = [
      { key: "group0" as const, dir: "asc" as const },
      { key: "count" as const, dir: "desc" as const },
    ];
    const clause: AggregationClause = {
      id: "m",
      op: "count",
      groupBy: ["group"],
      expression: "COUNT()",
      display: { kind },
      distribution: { kind, input: "[x]" },
      sort: [{ key: "samples", dir: "desc" }, ...commonSort],
    };
    const preview = vi.fn(async (drafts: AggregationClause[]) => ({
      metrics: drafts.map((c) => ({
        id: c.id,
        buckets: [{ keys: ["a"], count: 2, value: 2 }],
      })),
    }));
    const api = {
      aggregations: { clauses: [clause], preview },
      rows: [],
      total: 0,
      query: { where: [] },
    } as unknown as QueryTableApi<unknown>;
    const fields: FieldDef[] = [
      {
        name: "group",
        label: "Group",
        type: "text",
        source: { kind: "backend" },
      },
      { name: "x", label: "X", type: "number", source: { kind: "backend" } },
    ];
    const changeDisplay = async (next: string) => {
      act(() => {
        const select = host.querySelector<HTMLSelectElement>(
          '[aria-label="Metric display"]',
        )!;
        select.value = next;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => vi.advanceTimersByTimeAsync(300));
    };
    try {
      await act(async () =>
        root.render(
          createElement(MetricsEditor, { api, fields, onClose: vi.fn() }),
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(300));
      await changeDisplay(kind === "box" ? "histogram" : "box");
      expect(preview.mock.lastCall![0][0]!.sort).toEqual(clause.sort);
      await changeDisplay("table");
      expect(preview.mock.lastCall![0][0]!.sort).toEqual(commonSort);
      await changeDisplay("scatter");
      expect(preview.mock.lastCall![0][0]).toMatchObject({
        sort: commonSort,
        expressionY: "COUNT()",
      });
      await changeDisplay("table");
      expect(preview.mock.lastCall![0][0]!.sort).toEqual(commonSort);
      expect(clause.sort?.[0]?.key).toBe("samples");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it("removes Y sorting when leaving scatter while preserving group and value sorts", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sort: AggregationClause["sort"] = [
    { key: "y", dir: "desc" },
    { key: "group0", dir: "asc" },
    { key: "value", dir: "desc" },
  ];
  const preview = vi.fn(async () => ({ metrics: [{ id: "m", buckets: [] }] }));
  const api = {
    aggregations: {
      clauses: [
        {
          id: "m",
          op: "count",
          groupBy: ["group"],
          expression: "COUNT()",
          expressionY: "COUNT()",
          display: { kind: "scatter" },
          sort,
        },
      ],
      preview,
    },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, {
          api,
          fields: [
            {
              name: "group",
              label: "Group",
              type: "text",
              source: { kind: "backend" },
            },
          ],
          onClose: vi.fn(),
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(
        '[aria-label="Metric display"]',
      )!;
      select.value = "list";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(preview).toHaveBeenLastCalledWith(
      [expect.objectContaining({ sort: sort.slice(1) })],
      expect.any(AbortSignal),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("blocks grouped Value drafts, preserves cancel, and rejects conflicting Apply", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    replace = vi.fn(),
    onClose = vi.fn();
  const fields: FieldDef[] = [
    {
      name: "group",
      label: "Group",
      type: "text",
      source: { kind: "backend" },
    },
  ];
  const clauses: AggregationClause[] = [
    {
      id: "m",
      label: "Grouped",
      op: "count",
      groupBy: ["group"],
      display: { kind: "list" },
    },
  ];
  const preview = vi.fn(async () => ({
    metrics: [{ id: "m", buckets: [{ keys: ["a"], value: 2, count: 2 }] }],
  }));
  const api = {
    aggregations: { clauses, preview, replace },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  const render = async () => {
    await act(async () =>
      root.render(createElement(MetricsEditor, { api, fields, onClose })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
  };
  const button = (text: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    )!;
  const changeDisplay = (kind: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(
        '[aria-label="Metric display"]',
      )!;
      select.value = kind;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  try {
    await render();
    changeDisplay("value");
    expect(button("Apply metrics").disabled).toBe(true);
    expect(host.textContent).toContain("Remove the grouping keys");
    expect(clauses[0]!.display!.kind).toBe("list");
    act(() => button("Cancel").click());
    expect(replace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Keep editing").click());
    changeDisplay("table");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(button("Apply metrics").disabled).toBe(false);
    act(() => button("Apply metrics").click());
    expect(replace).toHaveBeenCalledWith(
      [expect.objectContaining({ display: { kind: "table" } })],
      clauses,
    );
    api.aggregations.clauses = [{ ...clauses[0]!, label: "External edit" }];
    await render();
    expect(button("Apply metrics").disabled).toBe(true);
    act(() => button("Cancel").click());
    act(() => button("Discard changes").click());
    expect(replace).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("keeps layout controls transactional and restores a removed metric in place", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    replace = vi.fn(),
    onClose = vi.fn();
  const clauses: AggregationClause[] = [
    { id: "first", label: "First", op: "count", groupBy: [] },
    { id: "second", label: "Second", op: "count", groupBy: [] },
  ];
  const preview = vi.fn(async (drafts: AggregationClause[]) => ({
    metrics: drafts.map((c) => ({
      id: c.id,
      buckets: [{ keys: [], value: 2, count: 2 }],
    })),
  }));
  const api = {
    aggregations: { clauses, preview, replace },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label,
    )!;
  const byText = (label: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    )!;
  try {
    await act(async () =>
      root.render(createElement(MetricsEditor, { api, fields: [], onClose })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    const previewCalls = preview.mock.calls.length;
    act(() => button("Metric list panel").click());
    act(() => button("Fields & functions panel").click());
    act(() => button("Definition panel").click());
    expect(button("Live preview panel").disabled).toBe(true);
    expect(
      host.querySelector(".qt-metric-library")?.hasAttribute("hidden"),
    ).toBe(true);
    act(() => byText("See in dashboard").click());
    expect(
      host
        .querySelector(".qt-metric-layout-card[aria-current=true]")
        ?.getAttribute("data-metric-id"),
    ).toBe("first");
    act(() => byText("Back to metric").click());
    expect(
      host.querySelector(".qt-metric-definition")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(
      host.querySelector(".qt-metric-reference")?.hasAttribute("hidden"),
    ).toBe(true);
    act(() => button("Metric list panel").click());
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(preview).toHaveBeenCalledTimes(previewCalls);
    const remove = Array.from(
      host.querySelectorAll(".qt-metric-library li:first-child button"),
    ).find((b) => b.textContent === "Remove") as HTMLButtonElement;
    act(() => remove.click());
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Editing metric"]')
        ?.value,
    ).toBe("second");
    act(() => byText("Undo remove").click());
    expect(
      Array.from(host.querySelectorAll(".qt-metric-library li")).map((el) =>
        el.getAttribute("data-reorder-id"),
      ),
    ).toEqual(["first", "second"]);
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Editing metric"]')
        ?.value,
    ).toBe("first");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(preview).toHaveBeenLastCalledWith(clauses, expect.any(AbortSignal));
    expect(replace).not.toHaveBeenCalled();
    expect(clauses).toEqual([
      { id: "first", label: "First", op: "count", groupBy: [] },
      { id: "second", label: "Second", op: "count", groupBy: [] },
    ]);
    act(() => byText("Cancel").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("previews valid metrics while a different draft needs repair", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const valid: AggregationClause = {
    id: "valid",
    label: "Valid",
    op: "count",
    groupBy: [],
  };
  const invalid: AggregationClause = {
    id: "invalid",
    label: "Invalid",
    op: "count",
    groupBy: [],
    expression: "SUM(",
  };
  const preview = vi.fn(async () => ({
    metrics: [{ id: "valid", buckets: [{ keys: [], value: 3, count: 3 }] }],
  }));
  const replace = vi.fn();
  const api = {
    aggregations: { clauses: [valid, invalid], preview, replace },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, { api, fields: [], onClose: vi.fn() }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(preview).toHaveBeenCalledWith([valid], expect.any(AbortSignal));
    expect(
      host.querySelector(".qt-metric-preview-card .qt-metric-big-value")
        ?.textContent,
    ).toContain("3");
    const review = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Review 1 issue",
    )!;
    act(() => review.click());
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Editing metric"]')
        ?.value,
    ).toBe("invalid");
    expect(
      Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === "Apply metrics",
      )?.disabled,
    ).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("routes backend result issues to the affected metric", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const clauses: AggregationClause[] = [
    { id: "first", label: "First", op: "count", groupBy: [] },
    { id: "failed", label: "Failed", op: "count", groupBy: [] },
  ];
  const api = {
    aggregations: {
      clauses,
      preview: async () => ({
        metrics: [
          { id: "first", buckets: [{ keys: [], value: 2, count: 2 }] },
          { id: "failed", buckets: [], error: "Execution budget exceeded" },
        ],
      }),
    },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, { api, fields: [], onClose: vi.fn() }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    const review = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Review 1 issue",
    )!;
    expect(review).toBeDefined();
    act(() => review.click());
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Editing metric"]')
        ?.value,
    ).toBe("failed");
    expect(
      host.querySelector(".qt-metric-preview-card")?.textContent,
    ).toContain("Execution budget exceeded");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("hides inactive distribution sort options and defaults custom Time labels to a time pattern", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const api = {
    aggregations: {
      clauses: [
        {
          id: "m",
          op: "count",
          groupBy: [],
          sort: [{ key: "value", dir: "asc" }],
          display: { kind: "box" },
          distribution: { kind: "box", input: "[x]" },
        },
      ],
    },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  const fields: FieldDef<unknown>[] = [
    { name: "x", label: "X", type: "number", source: { kind: "backend" } },
  ];
  const change = (label: string, value: string) => {
    const select = host.querySelector<HTMLSelectElement>(
      `[aria-label="${label}"]`,
    )!;
    expect(select).toBeTruthy();
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, { api, fields, onClose: vi.fn() }),
      ),
    );
    expect(
      host.querySelector('[aria-label="Sort result 1"]')?.textContent,
    ).toContain("Numeric samples");
    change("Metric display", "bar-vertical");
    const sort = host.querySelector('[aria-label="Sort result 1"]')!;
    expect(sort.textContent).not.toContain("Numeric samples");
    expect(sort.textContent).not.toContain("Median");
    change("Metric output type", "time");
    change("Label format", "custom");
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="Output format string"]',
      )?.value,
    ).toBe("HH:mm:ss");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("uses Escape to discard a numeric draft first, then closes the unmodified workbench", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    onClose = vi.fn();
  const api = {
    aggregations: { clauses: [{ id: "m", op: "count", groupBy: [] }] },
    rows: [],
    total: 0,
    query: { where: [] },
  } as unknown as QueryTableApi<unknown>;
  try {
    await act(async () =>
      root.render(
        createElement(MetricsEditor, {
          api,
          fields: [],
          onClose,
          initialView: "dashboard",
        }),
      ),
    );
    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="Canvas width"]',
    )!;
    expect(input).toBeTruthy();
    editInput(input, "700");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
