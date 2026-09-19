// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type {
  ColumnPreview,
  FieldDef,
  FieldStats,
  FormulaPlan,
} from "@pythia-software/query-table-core";
import { SelectColumnEditor } from "../src/SelectColumnEditor";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  happenedAt: string;
}

const field: FieldDef<Row> = {
  name: "happenedAt",
  label: "Happened at",
  type: "datetime",
  source: { kind: "backend" },
};
const constantField: FieldDef<Row> = {
  name: "constant",
  label: "Constant",
  type: "text",
  source: { kind: "backend" },
};
const variedField: FieldDef<Row> = {
  name: "varied",
  label: "Varied",
  type: "text",
  source: { kind: "backend" },
};
const plan: FormulaPlan = {
  ast: {
    kind: "field",
    name: field.name,
    valueType: "datetime",
    from: 0,
    to: field.name.length + 2,
  },
  dependencies: [field.name],
  type: "datetime",
};
const result: ColumnPreview = {
  dependencies: [field.name],
  processed: 1,
  total: 1,
  errors: 0,
  nulls: 0,
  groups: [],
};

function apiWith(
  preview: QueryTableApi<Row>["computed"]["preview"],
  fieldStats: QueryTableApi<Row>["fieldStats"] = async () => ({}),
) {
  return {
    defaults: { select: [{ field: field.name }] },
    select: { visible: [{ field: field.name }] },
    computed: {
      definitions: [],
      catalogue: [constantField, field, variedField],
      loading: false,
      error: null,
      reload: async () => undefined,
      save: async () => {
        throw new Error("not used");
      },
      compile: () => plan,
      preview,
    },
    fieldStats,
  } as unknown as QueryTableApi<Row>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SelectColumnEditor preview", () => {
  it("does not restart an equivalent preview when the API is recreated", async () => {
    const firstPreview = vi.fn().mockResolvedValue(result);
    const secondPreview = vi.fn().mockResolvedValue(result);

    await act(async () => {
      root = createRoot(container!);
      root.render(
        createElement(SelectColumnEditor<Row>, {
          api: apiWith(firstPreview),
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(firstPreview).toHaveBeenCalledOnce();

    await act(async () => {
      root!.render(
        createElement(SelectColumnEditor<Row>, {
          api: apiWith(secondPreview),
          onClose: () => undefined,
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(firstPreview).toHaveBeenCalledOnce();
    expect(secondPreview).not.toHaveBeenCalled();
  });

  it("shows distinct counts and moves low-cardinality fields to the end", async () => {
    const stats = vi.fn().mockResolvedValue({
      constant: { distinct: 1 },
      happenedAt: { distinct: 3 },
      varied: { distinct: 12 },
    } satisfies Record<string, FieldStats>);

    await act(async () => {
      root = createRoot(container!);
      root.render(
        createElement(SelectColumnEditor<Row>, {
          api: apiWith(vi.fn().mockResolvedValue(result), stats),
          onClose: () => undefined,
        }),
      );
      await Promise.resolve();
    });

    const items = Array.from(
      container!.querySelectorAll<HTMLElement>(".qt-catalogue-item"),
    );
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Happened at",
      "Varied",
      "Constant",
    ]);
    expect(items.map((item) => item.querySelector("small")?.textContent)).toEqual([
      expect.stringContaining("3 distinct"),
      expect.stringContaining("12 distinct"),
      expect.stringContaining("1 distinct"),
    ]);
    expect(items.at(-1)?.classList.contains("is-low-cardinality")).toBe(true);
    expect(stats).toHaveBeenCalledWith(
      ["constant", "happenedAt", "varied"],
      expect.any(AbortSignal),
    );
  });
});
