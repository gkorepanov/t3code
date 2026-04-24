import "../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  ensureLocalApiMock,
  getSavedEnvironmentSecretMock,
  openInPreferredEditorMock,
  readLocalApiMock,
  settingsState,
} = vi.hoisted(() => {
  const getSavedEnvironmentSecretMock = vi.fn(async () => "bearer-token");
  return {
    getSavedEnvironmentSecretMock,
    ensureLocalApiMock: vi.fn(() => ({
      persistence: {
        getSavedEnvironmentSecret: getSavedEnvironmentSecretMock,
        setSavedEnvironmentRegistry: vi.fn(async () => undefined),
      },
    })),
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: {
        openExternal: vi.fn(async () => undefined),
        openInEditor: vi.fn(async () => undefined),
      },
    })),
    settingsState: {
      browserFileLinkPrefix: "",
    },
  };
});

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: ensureLocalApiMock,
  readLocalApi: readLocalApiMock,
}));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => settingsState,
  useSettings: () => settingsState,
}));

import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    ensureLocalApiMock.mockClear();
    getSavedEnvironmentSecretMock.mockClear();
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    settingsState.browserFileLinkPrefix = "";
    useSavedEnvironmentRegistryStore.setState({ byId: {} });
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `/file${filePath}`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath, {
          reuseWindow: true,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `/file${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`, {
          reuseWindow: true,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `/file${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
          {
            reuseWindow: true,
          },
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("loads saved remote markdown images through authenticated fetch", async () => {
    const environmentId = EnvironmentId.make("environment-remote");
    const filePath = "/home/gkorepanov/tmp/experiments/2026_04_24_sine_plot/outputs/sine.png";
    const fetchMock = vi.fn(async () => {
      return new Response(new Blob(["png"], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const createObjectUrlMock = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sine");
    const revokeObjectUrlMock = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    useSavedEnvironmentRegistryStore.setState({
      byId: {
        [environmentId]: {
          environmentId,
          label: "Remote",
          wsBaseUrl: "wss://remote.example.com",
          httpBaseUrl: "https://remote.example.com",
          createdAt: "2026-04-24T00:00:00.000Z",
          lastConnectedAt: null,
        },
      },
    });

    const screen = await render(
      <ChatMarkdown
        text={`![sin(x)](${filePath})`}
        cwd="/home/gkorepanov/tmp"
        environmentId={environmentId}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://remote.example.com/file/home/gkorepanov/tmp/experiments/2026_04_24_sine_plot/outputs/sine.png",
          expect.objectContaining({
            credentials: "include",
            headers: {
              authorization: "Bearer bearer-token",
            },
          }),
        );
      });
      await expect
        .element(page.getByRole("img", { name: "sin(x)" }))
        .toHaveAttribute("src", "blob:sine");
    } finally {
      await screen.unmount();
      createObjectUrlMock.mockRestore();
      revokeObjectUrlMock.mockRestore();
    }
  });
});
