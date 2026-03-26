import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";
import { syncOrchestrationSnapshot } from "./orchestrationSync";

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

function makeSnapshot(threadId: ThreadId): OrchestrationReadModel {
  return {
    snapshotSequence: 7,
    updatedAt: "2026-03-24T12:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-03-24T12:00:00.000Z",
        updatedAt: "2026-03-24T12:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread 1",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-03-24T12:00:00.000Z",
        updatedAt: "2026-03-24T12:00:00.000Z",
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

describe("orchestrationSync", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createLocalStorageMock());
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
    });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("syncs the snapshot, clears promoted drafts, and removes orphan terminal state", async () => {
    const serverThreadId = ThreadId.makeUnsafe("thread-1");
    const draftThreadId = ThreadId.makeUnsafe("draft-1");
    const orphanThreadId = ThreadId.makeUnsafe("orphan-1");

    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {
        [serverThreadId]: {
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-24T11:00:00.000Z",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
        [draftThreadId]: {
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-24T11:30:00.000Z",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [ProjectId.makeUnsafe("project-2")]: draftThreadId,
      },
    });

    const terminalStore = useTerminalStateStore.getState();
    terminalStore.setTerminalOpen(serverThreadId, true);
    terminalStore.setTerminalOpen(draftThreadId, true);
    terminalStore.setTerminalOpen(orphanThreadId, true);

    const snapshot = makeSnapshot(serverThreadId);
    const getSnapshot = vi.fn().mockResolvedValue(snapshot);

    await expect(
      syncOrchestrationSnapshot({
        orchestration: {
          getSnapshot,
        },
      }),
    ).resolves.toEqual(snapshot);

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(useStore.getState().threadsHydrated).toBe(true);
    expect(useStore.getState().threads.map((thread) => thread.id)).toEqual([serverThreadId]);
    expect(useComposerDraftStore.getState().draftThreadsByThreadId[serverThreadId]).toBeUndefined();
    expect(useComposerDraftStore.getState().draftThreadsByThreadId[draftThreadId]).toBeDefined();
    expect(
      Object.keys(useTerminalStateStore.getState().terminalStateByThreadId).toSorted(),
    ).toEqual([draftThreadId, serverThreadId]);
  });
});
