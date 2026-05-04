import type { EnvironmentId, EnvironmentApi } from "@t3tools/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

interface EnvironmentApiOptions {
  readonly environmentId?: EnvironmentId;
}

function scheduleEventRefresh(environmentId: EnvironmentId | undefined) {
  if (!environmentId) {
    return;
  }

  queueMicrotask(() => {
    void readEnvironmentConnection(environmentId)
      ?.refreshEvents()
      .catch(() => undefined);
  });
}

async function withEventRefresh<T>(
  environmentId: EnvironmentId | undefined,
  operation: Promise<T>,
): Promise<T> {
  const result = await operation;
  scheduleEventRefresh(environmentId);
  return result;
}

export function createEnvironmentApi(
  rpcClient: WsRpcClient,
  options?: EnvironmentApiOptions,
): EnvironmentApi {
  const environmentId = options?.environmentId;

  return {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    git: {
      pull: rpcClient.git.pull,
      refreshStatus: rpcClient.git.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.git.onStatus(input, callback, options),
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    server: {
      transcribeVoice: rpcClient.server.transcribeVoice,
    },
    orchestration: {
      dispatchCommand: (input) =>
        withEventRefresh(environmentId, rpcClient.orchestration.dispatchCommand(input)),
      enqueueMessage: (input) =>
        withEventRefresh(environmentId, rpcClient.orchestration.enqueueMessage(input)),
      updateQueuedMessage: (input) =>
        withEventRefresh(environmentId, rpcClient.orchestration.updateQueuedMessage(input)),
      deleteQueuedMessage: async (input) => {
        await withEventRefresh(environmentId, rpcClient.orchestration.deleteQueuedMessage(input));
      },
      dispatchQueuedMessageNow: (input) =>
        withEventRefresh(environmentId, rpcClient.orchestration.dispatchQueuedMessageNow(input)),
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      subscribeEvents: (callback, options) =>
        rpcClient.orchestration.subscribeEvents(callback, options),
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
      subscribeThreadQueue: (input, callback, options) =>
        rpcClient.orchestration.subscribeThreadQueue(input, callback, options),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client, { environmentId }) : undefined;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
