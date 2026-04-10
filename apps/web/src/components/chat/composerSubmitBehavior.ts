export function shouldSubmitComposerOnEnter({
  ctrlKey,
  key,
  metaKey,
  requireMetaEnterToSend,
  shiftKey,
}: {
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  requireMetaEnterToSend: boolean;
  shiftKey: boolean;
}): boolean {
  return key === "Enter" && !shiftKey && (!requireMetaEnterToSend || metaKey || ctrlKey);
}

export function resolveRunningComposerControls({
  hasPendingProgress,
  isCoarsePointer,
  pendingUserInputCount,
  phase,
}: {
  hasPendingProgress: boolean;
  isCoarsePointer: boolean;
  pendingUserInputCount: number;
  phase: string;
}) {
  const showSeparateRunningStopButton =
    phase === "running" && isCoarsePointer && !hasPendingProgress && pendingUserInputCount === 0;

  return {
    showInlineRunningStopButton: phase === "running" && !showSeparateRunningStopButton,
    showSeparateRunningStopButton,
  };
}
