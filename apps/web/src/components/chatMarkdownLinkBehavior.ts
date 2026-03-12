export function shouldHandleMarkdownFileLinkClick(
  event: Pick<
    MouseEvent,
    "altKey" | "button" | "ctrlKey" | "defaultPrevented" | "metaKey" | "shiftKey"
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
