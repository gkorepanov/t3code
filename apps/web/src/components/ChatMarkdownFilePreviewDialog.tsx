import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  getSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
} from "../environments/runtime";
import { readLocalApi } from "../localApi";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const TEXT_PREVIEW_LIMIT = 200_000;
const TEXT_PREVIEW_SUFFIX = "\n\n... preview truncated ...";
const TEXT_FILE_EXTENSION_PATTERN =
  /\.(c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|sh|sql|svg|swift|toml|ts|tsx|txt|xml|yaml|yml)$/i;
const TEXT_CONTENT_TYPE_PATTERN =
  /(?:^text\/)|(?:json|javascript|typescript|xml|yaml|toml|csv|svg)/i;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export interface ChatMarkdownFilePreviewTarget {
  readonly browserHref: string;
  readonly environmentId?: EnvironmentId;
  readonly targetPath: string;
}

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "image"; readonly src: string }
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "unsupported"; readonly contentType: string | null };

function basename(targetPath: string): string {
  const normalized = targetPath.replace(POSITION_SUFFIX_PATTERN, "");
  const segments = normalized.split(/[\\/]/);
  return segments.at(-1) || normalized;
}

function looksLikeTextFile(targetPath: string, contentType: string | null): boolean {
  if (contentType && TEXT_CONTENT_TYPE_PATTERN.test(contentType)) {
    return true;
  }

  return TEXT_FILE_EXTENSION_PATTERN.test(targetPath.replace(POSITION_SUFFIX_PATTERN, ""));
}

function resolveBrowserPreviewUrl(browserHref: string): string {
  return new URL(browserHref, window.location.href).toString();
}

export async function resolveMarkdownFilePreviewRequestInit(
  preview: ChatMarkdownFilePreviewTarget,
): Promise<Pick<RequestInit, "credentials" | "headers">> {
  if (!preview.environmentId || !getSavedEnvironmentRecord(preview.environmentId)) {
    return { credentials: "include" };
  }

  const bearerToken = await readSavedEnvironmentBearerToken(preview.environmentId);
  if (!bearerToken) {
    return { credentials: "include" };
  }

  return {
    credentials: "include",
    headers: {
      authorization: `Bearer ${bearerToken}`,
    },
  };
}

async function readPreviewText(
  response: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return {
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

export function ChatMarkdownFilePreviewDialog({
  preview,
  onClose,
}: {
  preview: ChatMarkdownFilePreviewTarget | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    if (!preview) {
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    let imageObjectUrl: string | null = null;
    setState({ status: "loading" });
    const previewUrl = resolveBrowserPreviewUrl(preview.browserHref);

    void resolveMarkdownFilePreviewRequestInit(preview)
      .then((requestInit) =>
        fetch(previewUrl, {
          ...requestInit,
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load preview (${response.status}).`);
        }

        const contentType = response.headers.get("content-type");
        if (contentType?.toLowerCase().startsWith("image/")) {
          const blob = await response.blob();
          imageObjectUrl = URL.createObjectURL(blob);
          if (!disposed) {
            setState({ status: "image", src: imageObjectUrl });
          }
          return;
        }

        if (!looksLikeTextFile(preview.targetPath, contentType)) {
          if (!disposed) {
            setState({ status: "unsupported", contentType });
          }
          return;
        }

        const { text, truncated } = await readPreviewText(response, TEXT_PREVIEW_LIMIT);
        if (!disposed) {
          setState({
            status: "text",
            text: truncated ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}${TEXT_PREVIEW_SUFFIX}` : text,
            truncated,
          });
        }
      })
      .catch((error) => {
        if (disposed || controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load preview.",
        });
      });

    return () => {
      disposed = true;
      controller.abort();
      if (imageObjectUrl) {
        URL.revokeObjectURL(imageObjectUrl);
      }
    };
  }, [preview]);

  if (!preview) {
    return null;
  }

  const handleOpenInBrowser = () => {
    const targetUrl = resolveBrowserPreviewUrl(preview.browserHref);
    const api = readLocalApi();
    if (api) {
      void api.shell.openExternal(targetUrl).catch(() => undefined);
      return;
    }

    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{basename(preview.targetPath)}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {preview.targetPath}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {state.status === "loading" ? (
            <p className="text-muted-foreground text-sm">Loading preview...</p>
          ) : null}
          {state.status === "error" ? (
            <p className="text-destructive text-sm">{state.message}</p>
          ) : null}
          {state.status === "unsupported" ? (
            <p className="text-muted-foreground text-sm">
              Preview unavailable
              {state.contentType ? ` for ${state.contentType}.` : " for this file type."}
            </p>
          ) : null}
          {state.status === "image" ? (
            <img
              alt={basename(preview.targetPath)}
              className="mx-auto max-h-[70vh] rounded-lg border border-border/60 bg-black/3 object-contain"
              src={state.src}
            />
          ) : null}
          {state.status === "text" ? (
            <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
              <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap break-words">
                {state.text}
              </pre>
              {state.truncated ? (
                <div className="border-t border-border/60 px-4 py-2 text-muted-foreground text-xs">
                  Preview truncated.
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={handleOpenInBrowser}>
            Open in browser
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
