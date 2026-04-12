import { describe, expect, it, vi } from "vitest";

const { getSavedEnvironmentRecordMock, readSavedEnvironmentBearerTokenMock } = vi.hoisted(() => ({
  getSavedEnvironmentRecordMock: vi.fn(),
  readSavedEnvironmentBearerTokenMock: vi.fn(),
}));

vi.mock("../environments/runtime", () => ({
  getSavedEnvironmentRecord: getSavedEnvironmentRecordMock,
  readSavedEnvironmentBearerToken: readSavedEnvironmentBearerTokenMock,
}));

import { resolveMarkdownFilePreviewRequestInit } from "./ChatMarkdownFilePreviewDialog";

describe("resolveMarkdownFilePreviewRequestInit", () => {
  it("keeps local previews cookie-based", async () => {
    getSavedEnvironmentRecordMock.mockReturnValue(null);

    await expect(
      resolveMarkdownFilePreviewRequestInit({
        browserHref: "/file/Users/julius/project/src/main.ts",
        targetPath: "/Users/julius/project/src/main.ts",
      }),
    ).resolves.toEqual({
      credentials: "include",
    });

    expect(readSavedEnvironmentBearerTokenMock).not.toHaveBeenCalled();
  });

  it("adds bearer auth for saved remote environment previews", async () => {
    getSavedEnvironmentRecordMock.mockReturnValue({
      environmentId: "environment-remote",
    });
    readSavedEnvironmentBearerTokenMock.mockResolvedValue("bearer-token");

    await expect(
      resolveMarkdownFilePreviewRequestInit({
        browserHref: "https://remote.example.com/file/home/julius/project/src/main.ts",
        environmentId: "environment-remote" as never,
        targetPath: "/home/julius/project/src/main.ts",
      }),
    ).resolves.toEqual({
      credentials: "include",
      headers: {
        authorization: "Bearer bearer-token",
      },
    });
  });
});
