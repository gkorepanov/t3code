import * as React from "react";

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    if (!value) return;

    writeTextToClipboard(value).then(
      () => {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        if (onErrorRef.current) {
          onErrorRef.current(error, ctx);
        } else {
          console.error(error);
        }
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}

export async function writeTextToClipboard(value: string): Promise<void> {
  let browserError: unknown = null;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      browserError = error;
    }
  }

  if (typeof window !== "undefined" && window.desktopBridge?.writeClipboardText) {
    try {
      await window.desktopBridge.writeClipboardText(value);
      return;
    } catch (desktopError) {
      throw combineClipboardErrors(browserError, desktopError);
    }
  }

  if (browserError) {
    throw toError(browserError);
  }

  throw new Error("Clipboard API unavailable.");
}

function combineClipboardErrors(browserError: unknown, desktopError: unknown): Error {
  const fallbackMessage = toError(desktopError).message;
  if (!browserError) {
    return new Error(fallbackMessage);
  }

  const browserMessage = toError(browserError).message;
  return new Error(
    `Desktop clipboard fallback failed: ${fallbackMessage}. Browser clipboard failed first: ${browserMessage}`,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
