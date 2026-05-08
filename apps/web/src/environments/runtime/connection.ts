import type {
  EnvironmentId,
  OrchestrationEventDeltaStreamItem,
  OrchestrationStateSnapshot,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";
import type { KnownEnvironment } from "@t3tools/client-runtime";

import type { WsRpcClient } from "~/rpc/wsRpcClient";

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly refreshEvents: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface OrchestrationHandlers {
  readonly applyDeltaEvent: (
    item: Extract<OrchestrationEventDeltaStreamItem, { kind: "event" | "event-batch" }>,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncStateSnapshot: (
    snapshot: OrchestrationStateSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly loadStateSnapshot: (environmentId: EnvironmentId) => Promise<OrchestrationStateSnapshot>;
  readonly markCaughtUp: (sequence: number, environmentId: EnvironmentId) => boolean;
  readonly readAppliedSequence: (environmentId: EnvironmentId) => number | null;
  readonly hydrateCachedState?: (environmentId: EnvironmentId) => Promise<void>;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigSnapshot?: (config: ServerConfig) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

const NOOP = () => undefined;
const RECONNECT_BOOTSTRAP_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}

function createBootstrapGate() {
  type BootstrapGateStatus = "ready" | "reset";

  let resolve: ((status: BootstrapGateStatus) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  let promise = new Promise<BootstrapGateStatus>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    wait: async () => {
      for (;;) {
        const status = await promise;
        if (status === "ready") {
          return;
        }
      }
    },
    resolve: () => {
      resolve?.("ready");
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      reject?.(error);
      resolve = null;
      reject = null;
    },
    reset: () => {
      resolve?.("reset");
      promise = new Promise<BootstrapGateStatus>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
    },
  };
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const environmentId = input.knownEnvironment.environmentId;

  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;
  const bootstrapGate = createBootstrapGate();
  let unsubEvents: () => void = NOOP;
  let hasEventsSubscription = false;

  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };

  const resetBootstrap = () => {
    bootstrapGate.reset();
  };

  const unsubLifecycle = input.client.server.subscribeLifecycle(
    (event: Parameters<Parameters<WsRpcClient["server"]["subscribeLifecycle"]>[0]>[0]) => {
      if (event.type !== "welcome") {
        return;
      }
      observeEnvironmentIdentity(
        event.payload.environment.environmentId,
        "server lifecycle welcome",
      );
      input.onWelcome?.(event.payload);
    },
  );

  const unsubConfig = input.client.server.subscribeConfig(
    (event: Parameters<Parameters<WsRpcClient["server"]["subscribeConfig"]>[0]>[0]) => {
      if (event.type !== "snapshot") {
        return;
      }
      observeEnvironmentIdentity(event.config.environment.environmentId, "server config snapshot");
      input.onConfigSnapshot?.(event.config);
    },
  );

  const startOrchestrationSubscription = (options?: {
    readonly replaceExisting?: boolean;
    readonly fromSequenceExclusive?: number | null;
  }) => {
    if (disposed) {
      return;
    }
    if (hasEventsSubscription) {
      if (!options?.replaceExisting) {
        return;
      }
      unsubEvents();
      unsubEvents = NOOP;
      hasEventsSubscription = false;
    }

    unsubEvents = input.client.orchestration.subscribeEvents(
      (item: Parameters<Parameters<WsRpcClient["orchestration"]["subscribeEvents"]>[0]>[0]) => {
        if (item.kind === "snapshot") {
          input.syncStateSnapshot(item.snapshot, environmentId);
          bootstrapGate.resolve();
          return;
        }
        if (item.kind === "caught-up") {
          if (input.markCaughtUp(item.sequence, environmentId)) {
            bootstrapGate.resolve();
          }
          return;
        }
        input.applyDeltaEvent(item, environmentId);
      },
      {
        fromSequenceExclusive: () =>
          options?.fromSequenceExclusive ?? input.readAppliedSequence(environmentId),
        onResubscribe: () => {
          if (disposed) {
            return;
          }
          resetBootstrap();
        },
      },
    );
    hasEventsSubscription = true;
  };

  const loadInitialSnapshotIfNeeded = async (): Promise<{
    readonly fromSequenceExclusive: number | null;
    readonly loadedSnapshot: boolean;
  }> => {
    const currentSequence = input.readAppliedSequence(environmentId);
    if (currentSequence !== null) {
      return { fromSequenceExclusive: currentSequence, loadedSnapshot: false };
    }

    const snapshot = await input.loadStateSnapshot(environmentId);
    input.syncStateSnapshot(snapshot, environmentId);
    return { fromSequenceExclusive: snapshot.snapshotSequence, loadedSnapshot: true };
  };

  const hydrationPromise = Promise.resolve(input.hydrateCachedState?.(environmentId)).catch(
    () => undefined,
  );
  const bootstrapPromise = hydrationPromise
    .then(loadInitialSnapshotIfNeeded)
    .then(({ fromSequenceExclusive, loadedSnapshot }) => {
      startOrchestrationSubscription({ fromSequenceExclusive });
      if (loadedSnapshot) {
        bootstrapGate.resolve();
      }
    })
    .catch((error) => {
      bootstrapGate.reject(error);
    });

  const unsubTerminalEvent = input.client.terminal.onEvent(
    (event: Parameters<Parameters<WsRpcClient["terminal"]["onEvent"]>[0]>[0]) => {
      input.applyTerminalEvent(event, environmentId);
    },
  );

  const cleanup = () => {
    disposed = true;
    unsubEvents();
    hasEventsSubscription = false;
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => bootstrapGate.wait(),
    refreshEvents: async () => {
      if (disposed) {
        throw new Error("Environment connection disposed");
      }
      await bootstrapPromise;
      resetBootstrap();
      const { fromSequenceExclusive, loadedSnapshot } = await loadInitialSnapshotIfNeeded();
      startOrchestrationSubscription({ replaceExisting: true, fromSequenceExclusive });
      if (loadedSnapshot) {
        bootstrapGate.resolve();
      }
      await bootstrapGate.wait();
    },
    reconnect: async () => {
      resetBootstrap();
      try {
        await input.client.reconnect();
        await input.refreshMetadata?.();
        startOrchestrationSubscription({ replaceExisting: true });
        await withTimeout(
          bootstrapGate.wait(),
          RECONNECT_BOOTSTRAP_TIMEOUT_MS,
          "Timed out waiting for orchestration delta replay after reconnect.",
        );
      } catch (error) {
        bootstrapGate.reject(error);
        throw error;
      }
    },
    dispose: async () => {
      cleanup();
      await input.client.dispose();
    },
  };
}
