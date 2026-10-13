// @vitest-environment jsdom

import { act, createElement, Fragment, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { CollapsibleSection } from "../src/CollapsibleSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps Metrics and Table independently foldable with summaries and matching body references", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const [metricsCollapsed, setMetricsCollapsed] = useState(false);
    const [tableCollapsed, setTableCollapsed] = useState(false);
    return createElement(Fragment, null,
      createElement(CollapsibleSection, {
        title: "Metrics", collapsed: metricsCollapsed, onToggle: setMetricsCollapsed,
        collapsedSummary: "3 metrics", children: "Metric cards",
      }),
      createElement(CollapsibleSection, {
        title: "Table", collapsed: tableCollapsed, onToggle: setTableCollapsed,
        collapsedSummary: "100 rows", children: "Result rows",
      }),
    );
  }
  try {
    await act(async () => root.render(createElement(Fixture)));
    const [metrics, table] = Array.from(container.querySelectorAll<HTMLButtonElement>(".qt-qt-section-toggle"));
    const metricsBodyId = metrics!.getAttribute("aria-controls")!;
    const tableBodyId = table!.getAttribute("aria-controls")!;
    expect(metricsBodyId).not.toBe(tableBodyId);
    expect(document.getElementById(metricsBodyId)!.textContent).toBe("Metric cards");
    expect(document.getElementById(tableBodyId)!.textContent).toBe("Result rows");
    expect(Array.from(container.querySelectorAll(".qt-qt-section-summary"), element => element.textContent)).toEqual(["3 metrics", "100 rows"]);

    await act(async () => metrics!.click());
    expect(metrics!.getAttribute("aria-label")).toBe("Expand Metrics");
    expect(document.getElementById(metricsBodyId)).toBeNull();
    expect(table!.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(tableBodyId)).not.toBeNull();
    await act(async () => table!.click());
    expect(table!.getAttribute("aria-label")).toBe("Expand Table");
    expect(document.getElementById(tableBodyId)).toBeNull();
    expect(container.textContent).toContain("3 metrics");
    expect(container.textContent).toContain("100 rows");

    await act(async () => metrics!.click());
    expect(metrics!.getAttribute("aria-controls")).toBe(metricsBodyId);
    expect(document.getElementById(metricsBodyId)!.textContent).toBe("Metric cards");
    expect(table!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => table!.click());
    expect(document.getElementById(tableBodyId)!.textContent).toBe("Result rows");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
