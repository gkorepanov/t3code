import {
  buildMarkdownBrowserFileHref,
  buildMarkdownRemoteEditorHref,
  resolveMarkdownFileLinkTarget,
} from "../markdown-links";

export interface MarkdownFileLinkBehavior {
  readonly browserHref: string | undefined;
  readonly interceptsPlainClick: boolean;
  readonly remoteEditorHref: string | null;
  readonly targetPath: string | null;
}

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

export function resolveMarkdownFileLinkBehavior({
  browserFileLinkPrefix,
  cwd,
  hasNativeApi,
  href,
}: {
  browserFileLinkPrefix: string | undefined;
  cwd: string | undefined;
  hasNativeApi: boolean;
  href: string | undefined;
}): MarkdownFileLinkBehavior {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  const browserHref = buildMarkdownBrowserFileHref(targetPath);
  const remoteEditorHref = buildMarkdownRemoteEditorHref(targetPath, browserFileLinkPrefix);
  return {
    browserHref: browserHref ?? href,
    interceptsPlainClick: targetPath != null && (remoteEditorHref != null || hasNativeApi),
    remoteEditorHref,
    targetPath,
  };
}
