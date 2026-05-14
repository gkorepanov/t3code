import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const powerSyncMock = vi.hoisted(() => {
  class MockSchema {
    constructor(readonly tables: unknown) {}
  }

  class MockTable {
    constructor(readonly columns: unknown) {}
  }

  class MockPowerSyncDatabase {
    static instances: MockPowerSyncDatabase[] = [];

    readonly rows = new Map<
      string,
      { status: string; result_sequence: number | null; error: string | null }
    >();
    readonly listeners: Array<{
      readonly onChange: () => void;
      readonly onError: (error: unknown) => void;
    }> = [];
    connector: { uploadData: (database: MockPowerSyncDatabase) => Promise<void> } | null = null;
    crudBatch: {
      readonly crud: ReadonlyArray<{
        readonly op: "PUT" | "PATCH" | "DELETE";
        readonly table: string;
        readonly id: string;
        readonly opData?: Record<string, unknown>;
      }>;
      readonly complete: () => Promise<void>;
    } | null = null;

    readonly waitForReady = vi.fn(async () => undefined);
    readonly waitForFirstSync = vi.fn(async () => undefined);
    readonly connect = vi.fn(
      async (connector: { uploadData: (database: MockPowerSyncDatabase) => Promise<void> }) => {
        this.connector = connector;
      },
    );
    readonly disconnect = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly getCrudBatch = vi.fn(async () => this.crudBatch);
    readonly getOptional = vi.fn(async (_query: string, params: readonly unknown[]) => {
      return this.rows.get(String(params[0])) ?? null;
    });
    readonly execute = vi.fn(async (_query: string, params: readonly unknown[]) => {
      this.rows.set(String(params[0]), {
        status: "pending",
        result_sequence: null,
        error: null,
      });
    });
    readonly onChange = vi.fn(
      (
        listener: { readonly onChange: () => void; readonly onError: (error: unknown) => void },
        options?: { readonly triggerImmediate?: boolean },
      ) => {
        this.listeners.push(listener);
        if (options?.triggerImmediate) {
          queueMicrotask(listener.onChange);
        }
        return () => {
          const index = this.listeners.indexOf(listener);
          if (index >= 0) {
            this.listeners.splice(index, 1);
          }
        };
      },
    );

    constructor() {
      MockPowerSyncDatabase.instances.push(this);
    }

    triggerChange() {
      for (const listener of this.listeners) {
        listener.onChange();
      }
    }
  }

  return {
    MockPowerSyncDatabase,
    MockSchema,
    MockTable,
    column: {
      text: "text",
      integer: "integer",
    },
  };
});

vi.mock("@powersync/web", () => ({
  PowerSyncDatabase: powerSyncMock.MockPowerSyncDatabase,
  Schema: powerSyncMock.MockSchema,
  Table: powerSyncMock.MockTable,
  column: powerSyncMock.column,
}));

vi.mock("./readModel", () => ({
  readPowerSyncShellSnapshot: vi.fn(async () => ({
    snapshotSequence: 1,
    projects: [],
    threads: [],
    updatedAt: "2026-05-13T00:00:00.000Z",
  })),
  readPowerSyncThreadDetail: vi.fn(async () => null),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  powerSyncMock.MockPowerSyncDatabase.instances.length = 0;
  vi.clearAllMocks();
});

describe("createRemotePowerSyncState", () => {
  it("uploads local command deltas and only acknowledges them after the server accepts", async () => {
    const { createRemotePowerSyncState } = await import("./connection");
    const complete = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ acceptedCommandIds: ["cmd-1"] })),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const state = createRemotePowerSyncState({
      environmentId: EnvironmentId.make("env-remote"),
      httpBaseUrl: "https://remote.example.test/base",
      bearerToken: "bearer-token",
      onShellSnapshot: vi.fn(),
    });
    const db = powerSyncMock.MockPowerSyncDatabase.instances[0]!;
    await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(1));
    db.crudBatch = {
      crud: [
        {
          op: "PUT",
          table: "client_orchestration_commands",
          id: "cmd-1",
          opData: {
            command_json: "{}",
          },
        },
      ],
      complete,
    };

    await db.connector!.uploadData(db);

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.test/api/powersync/upload", {
      method: "POST",
      credentials: "omit",
      headers: {
        authorization: "Bearer bearer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        batch: [
          {
            op: "PUT",
            table: "client_orchestration_commands",
            id: "cmd-1",
            data: {
              command_json: "{}",
            },
          },
        ],
      }),
    });
    expect(complete).toHaveBeenCalledTimes(1);

    await state.dispose();
  });

  it("uses browser credentials instead of bearer auth when no bearer token is provided", async () => {
    const { createRemotePowerSyncState } = await import("./connection");
    const complete = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ acceptedCommandIds: ["cmd-1"] })),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const state = createRemotePowerSyncState({
      environmentId: EnvironmentId.make("env-primary"),
      httpBaseUrl: "https://remote.example.test/",
      onShellSnapshot: vi.fn(),
    });
    const db = powerSyncMock.MockPowerSyncDatabase.instances[0]!;
    await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(1));
    db.crudBatch = {
      crud: [
        {
          op: "PUT",
          table: "client_orchestration_commands",
          id: "cmd-1",
        },
      ],
      complete,
    };

    await db.connector!.uploadData(db);

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.test/api/powersync/upload", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        batch: [
          {
            op: "PUT",
            table: "client_orchestration_commands",
            id: "cmd-1",
          },
        ],
      }),
    });

    await state.dispose();
  });

  it("keeps the local batch unacknowledged when upload fails", async () => {
    const { createRemotePowerSyncState } = await import("./connection");
    const complete = vi.fn(async () => undefined);
    globalThis.fetch = vi.fn(async () => new Response("offline", { status: 503 })) as typeof fetch;

    const state = createRemotePowerSyncState({
      environmentId: EnvironmentId.make("env-remote"),
      httpBaseUrl: "https://remote.example.test/",
      bearerToken: "bearer-token",
      onShellSnapshot: vi.fn(),
    });
    const db = powerSyncMock.MockPowerSyncDatabase.instances[0]!;
    await vi.waitFor(() => expect(db.connect).toHaveBeenCalledTimes(1));
    db.crudBatch = {
      crud: [
        {
          op: "PUT",
          table: "client_orchestration_commands",
          id: "cmd-1",
        },
      ],
      complete,
    };

    await expect(db.connector!.uploadData(db)).rejects.toThrow("offline");
    expect(complete).not.toHaveBeenCalled();

    await state.dispose();
  });

  it("dispatches commands through the local PowerSync queue and resolves from synced server state", async () => {
    const { createRemotePowerSyncState } = await import("./connection");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ acceptedCommandIds: ["cmd-1"] })),
    ) as typeof fetch;

    const state = createRemotePowerSyncState({
      environmentId: EnvironmentId.make("env-remote"),
      httpBaseUrl: "https://remote.example.test/",
      bearerToken: "bearer-token",
      onShellSnapshot: vi.fn(),
    });
    const db = powerSyncMock.MockPowerSyncDatabase.instances[0]!;
    const command = {
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-1"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-05-13T00:00:00.000Z",
    } as const;

    const resultPromise = state.dispatchCommand(command);
    await vi.waitFor(() => expect(db.execute).toHaveBeenCalledTimes(1));
    db.rows.set(command.commandId, {
      status: "accepted",
      result_sequence: 42,
      error: null,
    });
    db.triggerChange();

    await expect(resultPromise).resolves.toEqual({ sequence: 42 });
    expect(db.execute.mock.calls[0]?.[1]).toEqual([
      command.commandId,
      command.commandId,
      "",
      JSON.stringify(command),
      expect.any(String),
      expect.any(String),
    ]);

    await state.dispose();
  });

  it("rejects dispatched commands from synced server rejection state", async () => {
    const { createRemotePowerSyncState } = await import("./connection");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ acceptedCommandIds: ["cmd-1"] })),
    ) as typeof fetch;

    const state = createRemotePowerSyncState({
      environmentId: EnvironmentId.make("env-remote"),
      httpBaseUrl: "https://remote.example.test/",
      bearerToken: "bearer-token",
      onShellSnapshot: vi.fn(),
    });
    const db = powerSyncMock.MockPowerSyncDatabase.instances[0]!;
    const command = {
      type: "thread.session.stop",
      commandId: CommandId.make("cmd-1"),
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-05-13T00:00:00.000Z",
    } as const;

    const resultPromise = state.dispatchCommand(command);
    await vi.waitFor(() => expect(db.execute).toHaveBeenCalledTimes(1));
    db.rows.set(command.commandId, {
      status: "rejected",
      result_sequence: null,
      error: "agent rejected the command",
    });
    db.triggerChange();

    await expect(resultPromise).rejects.toThrow("agent rejected the command");

    await state.dispose();
  });
});
