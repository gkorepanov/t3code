import { describe, expect, it } from "vitest";
import { shouldHandleMarkdownFileLinkClick } from "./chatMarkdownLinkBehavior";

function event(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as MouseEvent;
}

describe("shouldHandleMarkdownFileLinkClick", () => {
  it("handles plain primary clicks", () => {
    expect(shouldHandleMarkdownFileLinkClick(event())).toBe(true);
  });

  it("does not handle modified clicks", () => {
    expect(shouldHandleMarkdownFileLinkClick(event({ metaKey: true }))).toBe(false);
    expect(shouldHandleMarkdownFileLinkClick(event({ ctrlKey: true }))).toBe(false);
    expect(shouldHandleMarkdownFileLinkClick(event({ shiftKey: true }))).toBe(false);
    expect(shouldHandleMarkdownFileLinkClick(event({ altKey: true }))).toBe(false);
  });

  it("does not handle non-primary or already prevented clicks", () => {
    expect(shouldHandleMarkdownFileLinkClick(event({ button: 1 }))).toBe(false);
    expect(shouldHandleMarkdownFileLinkClick(event({ defaultPrevented: true }))).toBe(false);
  });
});
