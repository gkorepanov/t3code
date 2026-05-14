import {
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
  PowerSyncDatabase,
} from "@powersync/web";
import type {
  ClientOrchestrationCommand,
  DispatchResult,
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
  PowerSyncCredentialsResult,
  PowerSyncUploadResult,
} from "@t3tools/contracts";

import { t3PowerSyncSchema, powerSyncTables } from "./schema";
import { readPowerSyncShellSnapshot, readPowerSyncThreadDetail } from "./readModel";

type ShellSnapshotHandler = (snapshot: OrchestrationShellSnapshot) => void;

const noop = () => undefined;

export interface RemotePowerSyncState {
  readonly dispatchCommand: (command: ClientOrchestrationCommand) => Promise<DispatchResult>;
  readonly getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
  readonly subscribeShell: (callback: (item: OrchestrationShellStreamItem) => void) => () => void;
  readonly subscribeThread: (
    input: { readonly threadId: string },
    callback: (item: OrchestrationThreadStreamItem) => void,
  ) => () => void;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const response = await fetch(requestUrl, {
    method: input.method ?? "GET",
    credentials: input.bearerToken ? "omit" : "include",
    headers: {
      ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `PowerSync request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function createPowerSyncConnector(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken?: string;
}): PowerSyncBackendConnector {
  return {
    fetchCredentials: async () => {
      const credentials = await fetchJson<PowerSyncCredentialsResult>({
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/powersync/credentials",
        ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
      });
      return {
        endpoint: credentials.endpoint,
        token: credentials.token,
        expiresAt: new Date(credentials.expiresAt),
      };
    },
    uploadData: async (database: AbstractPowerSyncDatabase) => {
      const batch = await database.getCrudBatch();
      if (batch === null) {
        return;
      }
      await fetchJson<PowerSyncUploadResult>({
        httpBaseUrl: input.httpBaseUrl,
        pathname: "/api/powersync/upload",
        method: "POST",
        ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
        body: {
          batch: batch.crud.map((entry) => ({
            op: entry.op,
            table: entry.table,
            id: entry.id,
            ...(entry.opData !== undefined ? { data: entry.opData } : {}),
          })),
        },
      });
      await batch.complete();
    },
  };
}

function createBootstrapGate() {
  let settled = false;
  let resolve: (() => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  let promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    wait: () => promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolve?.();
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      if (settled) return;
      settled = true;
      reject?.(error);
      resolve = null;
      reject = null;
    },
    reset: () => {
      settled = false;
      promise = new Promise<void>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
    },
  };
}

async function publishShellSnapshot(
  db: PowerSyncDatabase,
  onSnapshot: ShellSnapshotHandler,
): Promise<void> {
  const snapshot = await readPowerSyncShellSnapshot(db);
  onSnapshot(snapshot);
}

async function waitForCommandResult(
  db: PowerSyncDatabase,
  commandId: string,
): Promise<DispatchResult> {
  return await new Promise((resolve, reject) => {
    let disposed = false;
    let unsubscribe: () => void = noop;
    const read = async () => {
      if (disposed) return;
      const row = await db.getOptional<{
        status: string;
        result_sequence: number | null;
        error: string | null;
      }>("SELECT status, result_sequence, error FROM client_orchestration_commands WHERE id = ?", [
        commandId,
      ]);
      if (!row || row.status === "pending" || row.status === "running") {
        return;
      }
      disposed = true;
      unsubscribe();
      if (row.status === "accepted") {
        resolve({ sequence: row.result_sequence ?? 0 });
        return;
      }
      reject(new Error(row.error ?? "PowerSync command was rejected."));
    };
    unsubscribe = db.onChange(
      {
        onChange: () => void read().catch(reject),
        onError: reject,
      },
      {
        tables: ["client_orchestration_commands"],
        throttleMs: 25,
        triggerImmediate: true,
      },
    );
    void read().catch(reject);
  });
}

function watchShell(db: PowerSyncDatabase, onSnapshot: ShellSnapshotHandler): () => void {
  const read = async () => {
    await publishShellSnapshot(db, onSnapshot);
  };
  const unsubscribe = db.onChange(
    {
      onChange: () => void read(),
      onError: (error) => console.warn("PowerSync shell watch failed", error),
    },
    {
      tables: [...powerSyncTables],
      throttleMs: 50,
      triggerImmediate: true,
    },
  );
  void read();
  return unsubscribe;
}

export function createRemotePowerSyncState(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly bearerToken?: string;
  readonly onShellSnapshot: ShellSnapshotHandler;
}): RemotePowerSyncState {
  const db = new PowerSyncDatabase({
    schema: t3PowerSyncSchema,
    database: {
      dbFilename: `t3code-remote-${input.environmentId}.db`,
    },
  });
  const connector = createPowerSyncConnector(input);
  const gate = createBootstrapGate();
  let disposed = false;
  let unsubscribeShell: () => void = noop;

  void db
    .waitForReady()
    .then(async () => {
      if (disposed) {
        return;
      }
      unsubscribeShell = watchShell(db, input.onShellSnapshot);
      await db.connect(connector);
      await db.waitForFirstSync();
      if (disposed) {
        return;
      }
      await publishShellSnapshot(db, input.onShellSnapshot);
      gate.resolve();
    })
    .catch((error) => {
      gate.reject(error);
      console.warn("PowerSync connection failed", error);
    });

  const subscribeThread: RemotePowerSyncState["subscribeThread"] = (threadInput, callback) => {
    const read = async () => {
      await db.waitForReady();
      const thread = await readPowerSyncThreadDetail(db, threadInput.threadId);
      if (thread === null) {
        return;
      }
      callback({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 0,
          thread,
        },
      });
    };
    const unsubscribe = db.onChange(
      {
        onChange: () => void read(),
        onError: (error) => console.warn("PowerSync thread watch failed", error),
      },
      {
        tables: [
          "projection_threads",
          "projection_thread_messages",
          "projection_thread_activities",
          "projection_thread_sessions",
          "projection_turns",
          "projection_thread_proposed_plans",
        ],
        throttleMs: 50,
        triggerImmediate: true,
      },
    );
    void read();
    return unsubscribe;
  };

  return {
    dispatchCommand: async (command) => {
      await db.waitForReady();
      const now = new Date().toISOString();
      await db.execute(
        `INSERT OR IGNORE INTO client_orchestration_commands (
           id,
           command_id,
           session_id,
           command_json,
           status,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [command.commandId, command.commandId, "", JSON.stringify(command), now, now],
      );
      return await waitForCommandResult(db, command.commandId);
    },
    getArchivedShellSnapshot: () => readPowerSyncShellSnapshot(db, { archived: true }),
    subscribeShell: (callback) => {
      const read = async () => {
        await db.waitForReady();
        callback({
          kind: "snapshot",
          snapshot: await readPowerSyncShellSnapshot(db),
        });
      };
      const unsubscribe = db.onChange(
        {
          onChange: () => void read(),
          onError: (error) => console.warn("PowerSync shell API watch failed", error),
        },
        { tables: [...powerSyncTables], throttleMs: 50, triggerImmediate: true },
      );
      void read();
      return unsubscribe;
    },
    subscribeThread,
    ensureBootstrapped: () => gate.wait(),
    reconnect: async () => {
      if (disposed) {
        return;
      }
      gate.reset();
      try {
        await db.disconnect();
        await db.connect(connector);
        await db.waitForFirstSync();
        await publishShellSnapshot(db, input.onShellSnapshot);
        gate.resolve();
      } catch (error) {
        gate.reject(error);
        throw error;
      }
    },
    dispose: async () => {
      disposed = true;
      unsubscribeShell();
      await db.close();
    },
  };
}
