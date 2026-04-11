import { describe, expect, it } from "vitest";

import { shouldSubmitComposerOnEnter } from "./composerEnterBehavior";

describe("shouldSubmitComposerOnEnter", () => {
  it("submits on Enter by default", () => {
    expect(
      shouldSubmitComposerOnEnter({
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        requireMetaEnterToSend: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("does not submit on Shift+Enter", () => {
    expect(
      shouldSubmitComposerOnEnter({
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        requireMetaEnterToSend: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it("requires Ctrl/Cmd+Enter when the preference is enabled", () => {
    expect(
      shouldSubmitComposerOnEnter({
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        requireMetaEnterToSend: true,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter({
        ctrlKey: true,
        key: "Enter",
        metaKey: false,
        requireMetaEnterToSend: true,
        shiftKey: false,
      }),
    ).toBe(true);
  });
});
