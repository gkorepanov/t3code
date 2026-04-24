import { afterEach, describe, expect, it, vi } from "vitest";

import { writeTextToClipboard } from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the browser clipboard when it succeeds", async () => {
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    const desktopWriteClipboardText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });
    vi.stubGlobal("window", { desktopBridge: { writeClipboardText: desktopWriteClipboardText } });

    await writeTextToClipboard("hello");

    expect(browserWriteText).toHaveBeenCalledWith("hello");
    expect(desktopWriteClipboardText).not.toHaveBeenCalled();
  });

  it("falls back to the desktop clipboard when browser clipboard write is denied", async () => {
    const browserWriteText = vi.fn().mockRejectedValue(new Error("permission denied"));
    const desktopWriteClipboardText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });
    vi.stubGlobal("window", { desktopBridge: { writeClipboardText: desktopWriteClipboardText } });

    await writeTextToClipboard("hello");

    expect(browserWriteText).toHaveBeenCalledWith("hello");
    expect(desktopWriteClipboardText).toHaveBeenCalledWith("hello");
  });

  it("uses the desktop clipboard when the browser clipboard API is missing", async () => {
    const desktopWriteClipboardText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { desktopBridge: { writeClipboardText: desktopWriteClipboardText } });

    await writeTextToClipboard("hello");

    expect(desktopWriteClipboardText).toHaveBeenCalledWith("hello");
  });

  it("keeps the original browser failure visible if the desktop fallback also fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("permission denied")) },
    });
    vi.stubGlobal("window", {
      desktopBridge: { writeClipboardText: vi.fn().mockRejectedValue(new Error("ipc failed")) },
    });

    await expect(writeTextToClipboard("hello")).rejects.toThrow(
      "Browser clipboard failed first: permission denied",
    );
  });
});
