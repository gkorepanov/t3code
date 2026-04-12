import type { EnvironmentId } from "@t3tools/contracts";

import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import {
  buildMarkdownBrowserFileHref,
  buildMarkdownRemoteEditorHref,
  resolveMarkdownFileLinkTarget,
} from "../markdown-links";
import { isTerminalLinkActivation } from "../terminal-links";

export interface MarkdownFileLinkBehavior {
  readonly browserHref: string | undefined;
  readonly interceptsPlainClick: boolean;
  readonly remoteEditorHref: string | null;
  readonly targetPath: string | null;
}

export interface MarkdownFileUrlBehavior {
  readonly browserHref: string | undefined;
  readonly targetPath: string | null;
}

export type MarkdownFilePlainClickAction = "browser" | "local-editor" | "remote-editor";

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

export function shouldPreviewMarkdownFileLinkClick(
  event: Pick<
    MouseEvent,
    "altKey" | "button" | "ctrlKey" | "defaultPrevented" | "metaKey" | "shiftKey"
  >,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.shiftKey &&
    isTerminalLinkActivation(event, platform)
  );
}

export function resolveMarkdownFilePlainClickAction(input: {
  readonly hasNativeApi: boolean;
  readonly remoteEditorHref: string | null;
}): MarkdownFilePlainClickAction {
  if (input.remoteEditorHref) {
    return "remote-editor";
  }
  if (input.hasNativeApi) {
    return "local-editor";
  }
  return "browser";
}

export function resolveMarkdownFileUrlBehavior({
  cwd,
  environmentId,
  href,
}: {
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
  href: string | undefined;
}): MarkdownFileUrlBehavior {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  const relativeBrowserHref = buildMarkdownBrowserFileHref(targetPath);
  const browserHref =
    relativeBrowserHref == null
      ? href
      : environmentId == null
        ? relativeBrowserHref
        : (() => {
            try {
              return resolveEnvironmentHttpUrl({
                environmentId,
                pathname: relativeBrowserHref,
              });
            } catch {
              return relativeBrowserHref;
            }
          })();
  return {
    browserHref: browserHref ?? href,
    targetPath,
  };
}

export function resolveMarkdownFileLinkBehavior({
  browserFileLinkPrefix,
  cwd,
  environmentId,
  hasNativeApi,
  href,
  preferLocalEditorOpen = false,
}: {
  browserFileLinkPrefix: string | undefined;
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
  hasNativeApi: boolean;
  href: string | undefined;
  preferLocalEditorOpen?: boolean;
}): MarkdownFileLinkBehavior {
  const { browserHref, targetPath } = resolveMarkdownFileUrlBehavior({
    cwd,
    environmentId,
    href,
  });
  const remoteEditorHref = preferLocalEditorOpen
    ? null
    : buildMarkdownRemoteEditorHref(targetPath, browserFileLinkPrefix);
  return {
    browserHref: browserHref ?? href,
    interceptsPlainClick: targetPath != null && (remoteEditorHref != null || hasNativeApi),
    remoteEditorHref,
    targetPath,
  };
}
