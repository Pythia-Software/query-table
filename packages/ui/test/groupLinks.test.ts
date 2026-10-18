import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_QUERY,
  createGroupingModel,
  prepareGrouping,
  readFieldValue,
  withGroupingKeys,
  type FieldSchema,
  type GroupLinkValue,
  type QueryState,
  type SummaryColumn,
} from "@pythia-software/query-table-core";
import { DataTable } from "../src/DataTable";
import { createGroupLinkRenderer, defaultRenderers, resolveRenderer } from "../src/renderers";

type Row = Record<string, unknown>;
const schema: FieldSchema<Row> = {
  name: "calls",
  idField: "id",
  fields: [
    { name: "id", label: "ID", type: "number", source: { kind: "backend" } },
    { name: "tool", label: "Tool", type: "text", source: { kind: "backend" } },
  ],
};
const rows: Row[] = [{ id: 1, tool: "apply_patch" }, { id: 2, tool: "bash" }];
const summaries: SummaryColumn[] = [
  { id: "open", op: "link", link: { label: { column: "tool" }, to: { kind: "query", target: "triage", params: { lens: "triage" } } } },
  { id: "page", op: "link", link: { label: "Page", to: { kind: "template", template: "/tools/{field:tool}" } } },
  { id: "evil", op: "link", link: { label: "Evil", to: { kind: "query", target: "evil" } } },
];
const query: QueryState = {
  ...withGroupingKeys(EMPTY_QUERY, ["tool"]),
  select: [{ field: "tool" }, { field: "open" }, { field: "page" }, { field: "evil" }],
  grouping: { keys: ["tool"], summaries, representative: null, source: EMPTY_QUERY },
};
const prepared = prepareGrouping(rows, schema, query.grouping!);
const field = (name: string) => prepared.schema.fields.find((f) => f.name === name)!;
const value = (name: string) => readFieldValue(field(name), prepared.rows[0]!) as GroupLinkValue;
const linkTargets = {
  triage: (q: QueryState, params: Record<string, string>) => `/triage?lens=${params.lens}&tool=${encodeURIComponent(String((q.where[0] as { value: string }).value))}`,
  evil: () => "javascript:alert(1)",
};
type AnchorProps = { href?: string; title?: string; rel?: string; onClick?: (event: unknown) => void; children?: unknown };
function render(name: string, options: Parameters<typeof createGroupLinkRenderer>[0] = { linkTargets }) {
  const node = createGroupLinkRenderer(options)({ value: value(name), row: prepared.rows[0], field: field(name), query });
  expect(isValidElement(node)).toBe(true);
  return node as ReactElement<AnchorProps>;
}
const click = (init: Partial<Record<"button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey", unknown>> = {}) => {
  const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
    nativeEvent: { type: "click" }, preventDefault: vi.fn(), ...init };
  return event;
};

describe("group link renderer", () => {
  it("renders host-routed query links as real anchors", () => {
    const node = render("open");
    expect(node.type).toBe("a");
    expect(node.props.href).toBe("/triage?lens=triage&tool=apply_patch");
    expect(node.props.children).toBe("apply_patch");
    expect(node.props.rel).toBeUndefined();
  });

  it("renders template links", () => {
    expect(render("page").props.href).toBe("/tools/apply_patch");
  });

  it("blocks unsafe hrefs and unregistered targets as muted text with a reason", () => {
    const evil = render("evil");
    expect(evil.type).toBe("span");
    expect(evil.props.href).toBeUndefined();
    expect(evil.props.title).toBe("Unsafe link blocked");
    const missing = render("open", {});
    expect(missing.type).toBe("span");
    expect(missing.props.title).toBe('Link target "triage" is not registered.');
  });

  it("calls onNavigate for unmodified primary clicks only", () => {
    const onNavigate = vi.fn(() => true);
    const node = render("open", { linkTargets, onNavigate });
    const plain = click();
    node.props.onClick!(plain);
    expect(onNavigate).toHaveBeenCalledWith("/triage?lens=triage&tool=apply_patch", plain.nativeEvent);
    expect(plain.preventDefault).toHaveBeenCalled();
    for (const modified of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = click(modified);
      node.props.onClick!(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const unhandled = click();
    render("open", { linkTargets, onNavigate: () => false }).props.onClick!(unhandled);
    expect(unhandled.preventDefault).not.toHaveBeenCalled();
  });

  it("composes the destination from the current query", () => {
    let routed: QueryState | undefined;
    render("open", { linkTargets: { triage: (q) => { routed = q; return "/t"; } } });
    expect(routed).toEqual({ ...EMPTY_QUERY, where: [{ field: "tool", op: "=", value: "apply_patch" }], offset: 0 });
  });
});

describe("DataTable link columns", () => {
  it("keeps rendering links when a column display override is set", () => {
    const registry = { ...defaultRenderers, [field("page").render as string]: createGroupLinkRenderer() };
    const node = resolveRenderer(field("page"), registry, { kind: "percent" })({ value: value("page"), row: prepared.rows[0], field: field("page"), query });
    expect(isValidElement(node) && node.type).toBe("a");
  });

  it("renders link columns with the host's link targets", () => {
    const resultSchema = createGroupingModel(schema).resultSchema(["tool"], summaries);
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      fields: ["tool", "open", "page"].map((name) => resultSchema.fields.find((f) => f.name === name)!),
      rows: prepared.rows,
      query,
      onQueryChange: () => undefined,
      renderers: defaultRenderers,
      rowId: () => null,
      linkTargets,
    }));
    expect(markup).toContain('href="/triage?lens=triage&amp;tool=bash"');
    expect(markup).toContain('href="/tools/bash"');
    expect(markup).not.toContain("[object Object]");
  });
});
