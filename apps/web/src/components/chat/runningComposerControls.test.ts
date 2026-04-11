import { describe, expect, it } from "vitest";

import { resolveRunningComposerControls } from "./runningComposerControls";

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
