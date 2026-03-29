import "../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";

const ALPHA_PROJECT_ID = "project-alpha" as ProjectId;
const BETA_PROJECT_ID = "project-beta" as ProjectId;
const ALPHA_THREAD_ID = "thread-alpha" as ThreadId;
const BETA_THREAD_ID = "thread-beta" as ThreadId;
const NOW_ISO = "2026-03-26T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
let pushSequence = 1;

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/alpha",
    keybindingsConfigPath: "/repo/alpha/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    settings: DEFAULT_SERVER_SETTINGS,
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
        models: [],
      },
    ],
    availableEditors: [],
  };
}

function createMessage(input: {
  id: MessageId;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}) {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: null,
    streaming: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function createSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: ALPHA_PROJECT_ID,
        title: "Project Alpha",
        workspaceRoot: "/repo/alpha",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
      {
        id: BETA_PROJECT_ID,
        title: "Project Beta",
        workspaceRoot: "/repo/beta",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: ALPHA_THREAD_ID,
        projectId: ALPHA_PROJECT_ID,
        title: "Alpha thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        archivedAt: null,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createMessage({
            id: "message-alpha" as MessageId,
            role: "user",
            text: "Set up the workspace shell helpers.",
            createdAt: NOW_ISO,
          }),
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
      {
        id: BETA_THREAD_ID,
        projectId: BETA_PROJECT_ID,
        title: "Refund thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        archivedAt: null,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [
          createMessage({
            id: "message-beta" as MessageId,
            role: "user",
            text: "Investigate ledger rollback in the refund workflow.",
            createdAt: NOW_ISO,
          }),
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/alpha",
      projectName: "Project Alpha",
      bootstrapProjectId: ALPHA_PROJECT_ID,
      bootstrapThreadId: ALPHA_THREAD_ID,
    },
  };
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    pushSequence = 1;
    client.send(
      JSON.stringify({
        type: "push",
        sequence: pushSequence++,
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let request: { id: string; body: { _tag: string } };
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }

      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(request.body._tag),
        }),
      );
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountApp() {
  await page.viewport(960, 900);

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ALPHA_THREAD_ID}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  await expect.element(page.getByText("Project Alpha")).toBeInTheDocument();
  await expect.element(page.getByText("Refund thread")).toBeInTheDocument();

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Sidebar dialog search", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    fixture = buildFixture();
    localStorage.clear();
    document.body.innerHTML = "";
    pushSequence = 1;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("filters projects by message text and reveals matches inside collapsed projects", async () => {
    const mounted = await mountApp();

    try {
      useStore.getState().setProjectExpanded(BETA_PROJECT_ID, false);
      await vi.waitFor(() => {
        expect(
          useStore.getState().projects.find((project) => project.id === BETA_PROJECT_ID)?.expanded,
        ).toBe(false);
      });
      await expect.element(page.getByText("Refund thread")).not.toBeInTheDocument();

      const searchInput = page.getByRole("searchbox", { name: "Search dialogs" });
      await searchInput.fill("rollback");

      await expect.element(page.getByText("Project Beta")).toBeInTheDocument();
      await expect.element(page.getByText("Refund thread")).toBeInTheDocument();
      await expect.element(page.getByText("Project Alpha")).not.toBeInTheDocument();
      await expect.element(page.getByText("Alpha thread")).not.toBeInTheDocument();

      await searchInput.fill("");

      await expect.element(page.getByText("Project Alpha")).toBeInTheDocument();
      await expect.element(page.getByText("Alpha thread")).toBeInTheDocument();
      await expect.element(page.getByText("Project Beta")).toBeInTheDocument();
      await expect.element(page.getByText("Refund thread")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an empty state when no dialogs match the query", async () => {
    const mounted = await mountApp();

    try {
      const searchInput = page.getByRole("searchbox", { name: "Search dialogs" });
      await searchInput.fill("no-such-dialog");

      await expect.element(page.getByText("No dialogs found.")).toBeInTheDocument();
      await expect.element(page.getByText("Project Alpha")).not.toBeInTheDocument();
      await expect.element(page.getByText("Project Beta")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the desktop sidebar from the chat header", async () => {
    const mounted = await mountApp();

    try {
      const hideButton = page.getByRole("button", { name: "Hide sidebar" });
      await expect.element(hideButton).toBeInTheDocument();

      await hideButton.click();
      await expect.element(page.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();

      await page.getByRole("button", { name: "Show sidebar" }).click();
      await expect.element(page.getByRole("button", { name: "Hide sidebar" })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
