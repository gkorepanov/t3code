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
