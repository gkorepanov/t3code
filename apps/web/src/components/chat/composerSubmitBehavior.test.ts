import { describe, expect, it } from "vitest";

import {
  resolveRunningComposerControls,
  shouldSubmitComposerOnEnter,
} from "./composerSubmitBehavior";

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

describe("resolveRunningComposerControls", () => {
  it("shows a separate stop button on touch devices while running", () => {
    expect(
      resolveRunningComposerControls({
        hasPendingProgress: false,
        isCoarsePointer: true,
        pendingUserInputCount: 0,
        phase: "running",
      }),
    ).toEqual({
      showInlineRunningStopButton: false,
      showSeparateRunningStopButton: true,
    });
  });

  it("keeps the inline stop button for non-touch or pending-input states", () => {
    expect(
      resolveRunningComposerControls({
        hasPendingProgress: true,
        isCoarsePointer: true,
        pendingUserInputCount: 0,
        phase: "running",
      }),
    ).toEqual({
      showInlineRunningStopButton: true,
      showSeparateRunningStopButton: false,
    });
  });
});
