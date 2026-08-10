import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { defaultRenderers, safeLinkHref } from "../src/renderers";

describe("safeLinkHref", () => {
  it.each([
    "https://example.com/report",
    "http://example.com",
    "mailto:security@example.com",
    "tel:+15551234567",
    "/runs/42",
    "../artifact/42",
    "#details",
  ])("allows navigation URL %s", (href) => {
    expect(safeLinkHref(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/id",
  ])("blocks executable or local URL %s", (href) => {
    expect(safeLinkHref(href)).toBeNull();
  });

  it("renders an unsafe value as text without an href", () => {
    const node = defaultRenderers.link!({ value: "javascript:alert(1)" } as never);
    expect(isValidElement<{ href?: string }>(node)).toBe(true);
    if (!isValidElement<{ href?: string }>(node)) return;
    expect(node.type).toBe("span");
    expect(node.props.href).toBeUndefined();
  });

  it("renders an allowed value as a protected new-tab link", () => {
    const node = defaultRenderers.link!({ value: "https://example.com" } as never);
    expect(isValidElement<{ href?: string; rel?: string }>(node)).toBe(true);
    if (!isValidElement<{ href?: string; rel?: string }>(node)) return;
    expect(node.type).toBe("a");
    expect(node.props.href).toBe("https://example.com");
    expect(node.props.rel).toBe("noopener noreferrer");
  });
});
