import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { RpcClient } from "effect/unstable/rpc";

import { ClientTracingLive } from "../observability/clientTracing";
import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsProtocolLifecycleOptions,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import { isTransportConnectionErrorMessage } from "./transportError";
import { getWsReconnectDelayMsForRetry } from "./wsConnectionState";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const MAX_SESSION_RECOVERY_DELAY_MS = 5_000;
const NOOP: () => void = () => undefined;

interface WsTransportOptions {
  readonly trackConnectionState?: boolean;
}

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private reconnectChain: Promise<void> = Promise.resolve();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRecoveryAttempt = 0;
  private session: TransportSession;

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    private readonly options?: WsTransportOptions,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          if (hasReceivedValue) {
            try {
              options?.onResubscribe?.();
            } catch {
              // Swallow reconnect hook errors so the stream can recover.
            }
          }

          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            console.warn("WebSocket RPC subscription failed", {
              error: formattedError,
            });
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
          await this.replaceSession(session).catch(() => undefined);
        }
      }
    })();

    return () => {
      active = false;
      cancelCurrentStream();
    };
  }

  async reconnect() {
    await this.replaceSession();
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearRecoveryTimer();
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession) {
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      session.runtime.dispose();
    });
  }

  private async replaceSession(expectedSession?: TransportSession) {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }
      if (expectedSession !== undefined && this.session !== expectedSession) {
        return;
      }

      this.clearRecoveryTimer();
      clearAllTrackedRpcRequests();
      const previousSession = this.session;
      this.session = this.createSession();
      void this.closeSession(previousSession).catch(() => undefined);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  private createSession(): TransportSession {
    let session!: TransportSession;
    const lifecycleHandlers: WsProtocolLifecycleHandlers = {
      onAttempt: (socketUrl) => {
        this.lifecycleHandlers?.onAttempt?.(socketUrl);
      },
      onOpen: () => {
        this.sessionRecoveryAttempt = 0;
        this.clearRecoveryTimer();
        this.lifecycleHandlers?.onOpen?.();
      },
      onError: (message) => {
        this.lifecycleHandlers?.onError?.(message);
      },
      onClose: (details) => {
        this.lifecycleHandlers?.onClose?.(details);
        this.scheduleSessionRecovery(session);
      },
    };
    const lifecycleOptions: WsProtocolLifecycleOptions = {
      shouldHandleLifecycle: () => !this.disposed && this.session === session,
      ...(this.options?.trackConnectionState === false ? { trackConnectionState: false } : {}),
    };
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(this.url, lifecycleHandlers, lifecycleOptions),
        ClientTracingLive,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = Promise.resolve().then(() =>
      runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient)),
    );
    session = {
      runtime,
      clientScope,
      clientPromise,
    };
    return session;
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer === null) {
      return;
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private scheduleSessionRecovery(session: TransportSession) {
    if (this.disposed || this.session !== session || this.recoveryTimer !== null) {
      return;
    }

    const retryDelay =
      getWsReconnectDelayMsForRetry(this.sessionRecoveryAttempt) ??
      Duration.toMillis(DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS);
    const delayMs = Math.min(retryDelay, MAX_SESSION_RECOVERY_DELAY_MS);
    this.sessionRecoveryAttempt += 1;

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.replaceSession(session).catch(() => undefined);
    }, delayMs);
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
