import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

function createTestClient() {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const terminalListeners = new Set<(event: any) => void>();
  const eventListeners = new Set<(event: any) => void>();
  const eventSubscribeCursors: Array<number | null> = [];
  let eventsResubscribe: (() => void) | undefined;

  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => {
      eventsResubscribe?.();
    }),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env-1"),
        },
      })),
      subscribeConfig: (listener: (event: any) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
      subscribeLifecycle: (listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      subscribeEvents: vi.fn(
        (
          listener: (event: any) => void,
          options?: {
            fromSequenceExclusive?: () => number | null;
            onResubscribe?: () => void;
          },
        ) => {
          eventListeners.add(listener);
          eventSubscribeCursors.push(options?.fromSequenceExclusive?.() ?? null);
          eventsResubscribe = options?.onResubscribe;
          queueMicrotask(() => {
            listener({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 1,
                projects: [],
                threads: [],
                updatedAt: "2026-04-12T00:00:00.000Z",
              },
            });
          });
          return () => {
            eventListeners.delete(listener);
            if (eventsResubscribe === options?.onResubscribe) {
              eventsResubscribe = undefined;
            }
          };
        },
      ),
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: vi.fn(() => () => undefined),
    },
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: (listener: (event: any) => void) => {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      pull: vi.fn(async () => undefined),
      refreshStatus: vi.fn(async () => undefined),
      onStatus: vi.fn(() => () => undefined),
      runStackedAction: vi.fn(async () => ({}) as any),
      listBranches: vi.fn(async () => []),
      createWorktree: vi.fn(async () => undefined),
      removeWorktree: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  } as unknown as WsRpcClient;

  return {
    client,
    eventSubscribeCursors,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigSnapshot: (environmentId: EnvironmentId) => {
      for (const listener of configListeners) {
        listener({
          type: "snapshot",
          config: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitEventSnapshot: (snapshotSequence: number) => {
      for (const listener of eventListeners) {
        listener({
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            projects: [],
            threads: [],
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        });
      }
    },
    emitDeltaEvent: (sequence: number) => {
      for (const listener of eventListeners) {
        listener({
          kind: "event",
          event: {
            sequence,
            type: "thread.session-stop-requested",
            payload: {
              threadId: "thread-1",
              createdAt: "2026-04-12T00:00:00.000Z",
            },
          },
        });
      }
    },
    emitCaughtUp: (sequence: number) => {
      for (const listener of eventListeners) {
        listener({
          kind: "caught-up",
          sequence,
        });
      }
    },
  };
}

describe("createEnvironmentConnection", () => {
  it("bootstraps from the shell subscription snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyDeltaEvent: vi.fn(),
      syncShellSnapshot,
      markCaughtUp: vi.fn(() => true),
      readAppliedSequence: vi.fn(() => null),
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    expect(syncShellSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitWelcome } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyDeltaEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      markCaughtUp: vi.fn(() => true),
      readAppliedSequence: vi.fn(() => null),
      applyTerminalEvent: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.make("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );

    await connection.dispose();
  });

  it("hydrates cached state before subscribing to event replay", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, eventSubscribeCursors } = createTestClient();
    let appliedSequence: number | null = null;

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyDeltaEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      markCaughtUp: vi.fn(() => true),
      readAppliedSequence: vi.fn(() => appliedSequence),
      hydrateCachedState: vi.fn(async () => {
        appliedSequence = 7;
      }),
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    expect(eventSubscribeCursors).toEqual([7]);

    await connection.dispose();
  });

  it("waits for a fresh shell snapshot after reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitCaughtUp, emitDeltaEvent } = createTestClient();
    const syncShellSnapshot = vi.fn();
    const applyDeltaEvent = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyDeltaEvent,
      syncShellSnapshot,
      markCaughtUp: vi.fn(() => true),
      readAppliedSequence: vi.fn(() => 1),
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);

    emitDeltaEvent(2);
    emitCaughtUp(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);
    expect(applyDeltaEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ sequence: 2 }),
      }),
      environmentId,
    );

    await connection.dispose();
  });
});
