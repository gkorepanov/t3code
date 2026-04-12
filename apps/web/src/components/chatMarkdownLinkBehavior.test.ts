import { describe, expect, it } from "vitest";

import {
  resolveMarkdownFileLinkBehavior,
  shouldHandleMarkdownFileLinkClick,
} from "./chatMarkdownLinkBehavior";

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

describe("resolveMarkdownFileLinkBehavior", () => {
  it("rewrites markdown file urls to browser-served absolute paths", () => {
    expect(
      resolveMarkdownFileLinkBehavior({
        browserFileLinkPrefix: "",
        cwd: "/home/julius/project",
        hasNativeApi: false,
        href: "file:///home/julius/project/src/main.ts",
      }),
    ).toEqual({
      browserHref: "/file/home/julius/project/src/main.ts",
      interceptsPlainClick: false,
      remoteEditorHref: null,
      targetPath: "/home/julius/project/src/main.ts",
    });
  });

  it("builds remote editor links for plain browser clicks", () => {
    expect(
      resolveMarkdownFileLinkBehavior({
        browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
        cwd: "/home/julius/project",
        hasNativeApi: false,
        href: "src/main.ts:42",
      }),
    ).toEqual({
      browserHref: "/file/home/julius/project/src/main.ts:42",
      interceptsPlainClick: true,
      remoteEditorHref:
        "vscode://vscode-remote/ssh-remote+wf-gk/home/julius/project/src/main.ts:42",
      targetPath: "/home/julius/project/src/main.ts:42",
    });
  });

  it("prefers native editor handling when a desktop override is present", () => {
    expect(
      resolveMarkdownFileLinkBehavior({
        browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
        cwd: "/home/julius/project",
        hasNativeApi: true,
        href: "src/main.ts:42",
        preferLocalEditorOpen: true,
      }),
    ).toEqual({
      browserHref: "/file/home/julius/project/src/main.ts:42",
      interceptsPlainClick: true,
      remoteEditorHref: null,
      targetPath: "/home/julius/project/src/main.ts:42",
    });
  });
});
