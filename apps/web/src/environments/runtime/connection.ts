import type {
  EnvironmentId,
  OrchestrationEventDeltaStreamItem,
  OrchestrationShellSnapshot,
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
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface OrchestrationHandlers {
  readonly applyDeltaEvent: (
    item: Extract<OrchestrationEventDeltaStreamItem, { kind: "event" }>,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly markCaughtUp: (sequence: number, environmentId: EnvironmentId) => boolean;
  readonly readAppliedSequence: (environmentId: EnvironmentId) => number | null;
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

  const unsubEvents = input.client.orchestration.subscribeEvents(
    (item: Parameters<Parameters<WsRpcClient["orchestration"]["subscribeEvents"]>[0]>[0]) => {
      if (item.kind === "snapshot") {
        input.syncShellSnapshot(item.snapshot, environmentId);
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
      fromSequenceExclusive: () => input.readAppliedSequence(environmentId),
      onResubscribe: () => {
        if (disposed) {
          return;
        }
        resetBootstrap();
      },
    },
  );

  const unsubTerminalEvent = input.client.terminal.onEvent(
    (event: Parameters<Parameters<WsRpcClient["terminal"]["onEvent"]>[0]>[0]) => {
      input.applyTerminalEvent(event, environmentId);
    },
  );

  const cleanup = () => {
    disposed = true;
    unsubEvents();
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
    reconnect: async () => {
      resetBootstrap();
      try {
        await input.client.reconnect();
        await input.refreshMetadata?.();
        await bootstrapGate.wait();
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
