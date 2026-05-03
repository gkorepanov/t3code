import { QueryClient } from "@tanstack/react-query";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockPersistCachedAppliedState = vi.fn();
const mockReadCachedEnvironmentState = vi.fn();
const mockDeleteCachedThreadDetail = vi.fn();
const mockTouchCachedThreadDetail = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

vi.mock("./orchestrationStateCache", () => ({
  clearCachedThreadDetailsForEnvironment: vi.fn(async () => undefined),
  deleteCachedThreadDetail: mockDeleteCachedThreadDetail,
  persistCachedAppliedState: mockPersistCachedAppliedState,
  readCachedEnvironmentState: mockReadCachedEnvironmentState,
  touchCachedThreadDetail: mockTouchCachedThreadDetail,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
      },
    ],
  };
}

function makeThreadDetail(threadId: ThreadId): OrchestrationThread {
  const shell = makeThreadShellSnapshot({ threadId }).threads[0]!;
  return {
    ...shell,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-1"),
        role: "assistant",
        text: "hello",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

function makeThreadMessageSentEvent(params: {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly streaming: boolean;
}): OrchestrationEvent {
  const timestamp = "2026-04-13T00:00:01.000Z";
  return {
    sequence: params.sequence,
    eventId: EventId.make(`event-${params.sequence}`),
    aggregateKind: "thread",
    aggregateId: params.threadId,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: params.threadId,
      messageId: params.messageId,
      role: "assistant",
      text: params.text,
      turnId: TurnId.make("turn-1"),
      streaming: params.streaming,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockDeleteCachedThreadDetail.mockResolvedValue(undefined);
    mockPersistCachedAppliedState.mockResolvedValue(undefined);
    mockReadCachedEnvironmentState.mockResolvedValue({ shell: null, threads: [] });
    mockTouchCachedThreadDetail.mockResolvedValue(undefined);
    mockCreateWsRpcClient.mockReturnValue({
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => ({
      kind: input.kind,
      environmentId: input.knownEnvironment.environmentId,
      knownEnvironment: input.knownEnvironment,
      client: input.client,
      ensureBootstrapped: vi.fn(async () => undefined),
      refreshEvents: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    }));
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("persists cached thread details at the same checkpoint as the shell", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    let threadListener:
      | ((item: {
          kind: "snapshot";
          snapshot: { snapshotSequence: number; thread: OrchestrationThread };
        }) => void)
      | undefined;
    mockSubscribeThread.mockImplementation((_input, listener) => {
      threadListener = listener;
      return mockThreadUnsubscribe;
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-cached");
    const projectId = ProjectId.make("project-1");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(makeThreadShellSnapshot({ threadId }), environmentId);
    mockPersistCachedAppliedState.mockClear();

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emitThreadSnapshot = threadListener;
    expect(emitThreadSnapshot).toBeDefined();
    emitThreadSnapshot!({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: makeThreadDetail(threadId),
      },
    });

    connectionInput.applyShellEvent(
      {
        kind: "project-upserted",
        sequence: 2,
        project: {
          id: projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockPersistCachedAppliedState).toHaveBeenLastCalledWith({
      environmentId,
      shell: expect.objectContaining({ snapshotSequence: 2 }),
      threadDetails: [
        expect.objectContaining({
          threadId,
          sequence: 2,
          thread: expect.objectContaining({ id: threadId }),
        }),
      ],
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("evicts stale cached thread details during hydration", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-stale");
    const shell = {
      ...makeThreadShellSnapshot({ threadId }),
      snapshotSequence: 2,
    };
    mockReadCachedEnvironmentState.mockResolvedValueOnce({
      shell,
      threads: [
        {
          version: 1,
          key: "env-1\u0000thread-stale",
          environmentId,
          threadId,
          sequence: 1,
          thread: makeThreadDetail(threadId),
          updatedAtMs: 1,
          lastAccessedAtMs: 1,
          sizeBytes: 1,
        },
      ],
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    await connectionInput.hydrateCachedState(environmentId);

    expect(mockDeleteCachedThreadDetail).toHaveBeenCalledWith(environmentId, threadId);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("refreshes retained cached thread details from the server snapshot", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    let threadListener:
      | ((item: {
          kind: "snapshot";
          snapshot: { snapshotSequence: number; thread: OrchestrationThread };
        }) => void)
      | undefined;
    mockSubscribeThread.mockImplementation((_input, listener) => {
      threadListener = listener;
      return mockThreadUnsubscribe;
    });

    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-cached-refresh");
    const shell = {
      ...makeThreadShellSnapshot({ threadId }),
      snapshotSequence: 5,
    };
    const cachedThreadBase = makeThreadDetail(threadId);
    const cachedThread: OrchestrationThread = {
      ...cachedThreadBase,
      messages: [
        {
          ...cachedThreadBase.messages[0]!,
          text: "tail only",
        },
      ],
    };
    const freshThread = makeThreadDetail(threadId);
    mockReadCachedEnvironmentState.mockResolvedValueOnce({
      shell,
      threads: [
        {
          version: 1,
          key: "env-1\u0000thread-cached-refresh",
          environmentId,
          threadId,
          sequence: 5,
          thread: cachedThread,
          updatedAtMs: 1,
          lastAccessedAtMs: 1,
          sizeBytes: 1,
        },
      ],
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    await connectionInput.hydrateCachedState(environmentId);
    const release = retainThreadDetailSubscription(environmentId, threadId);

    expect(mockTouchCachedThreadDetail).toHaveBeenCalledWith(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledWith({ threadId }, expect.any(Function));
    expect(threadListener).toBeDefined();

    threadListener!({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 5,
        thread: freshThread,
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockPersistCachedAppliedState).toHaveBeenLastCalledWith({
      environmentId,
      shell: expect.objectContaining({ snapshotSequence: 5 }),
      threadDetails: [
        expect.objectContaining({
          threadId,
          sequence: 5,
          thread: expect.objectContaining({
            messages: [expect.objectContaining({ text: "hello" })],
          }),
        }),
      ],
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not materialize a tail-only assistant message when replay starts mid-stream before thread snapshot", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    const { useStore } = await import("~/store");

    let threadListener:
      | ((
          item:
            | {
                kind: "snapshot";
                snapshot: { snapshotSequence: number; thread: OrchestrationThread };
              }
            | {
                kind: "event";
                event: OrchestrationEvent;
              },
        ) => void)
      | undefined;
    mockSubscribeThread.mockImplementation((_input, listener) => {
      threadListener = listener;
      return mockThreadUnsubscribe;
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-global-delta-race");
    const messageId = MessageId.make("assistant-racing-message");
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(makeThreadShellSnapshot({ threadId }), environmentId);
    const release = retainThreadDetailSubscription(environmentId, threadId);

    connectionInput.applyDeltaEvent(
      {
        kind: "event",
        event: makeThreadMessageSentEvent({
          sequence: 2,
          threadId,
          messageId,
          text: "(`~425px`) до нормальной",
          streaming: true,
        }),
      },
      environmentId,
    );
    await vi.advanceTimersByTimeAsync(50);

    const racedState = useStore.getState().environmentStateById[environmentId];
    expect(racedState?.messageByThreadId[threadId]?.[messageId]).toBeUndefined();

    const fullThread: OrchestrationThread = {
      ...makeThreadDetail(threadId),
      messages: [
        {
          ...makeThreadDetail(threadId).messages[0]!,
          id: messageId,
          text: "После правки body поднялся с середины (`~425px`) до нормальной позиции.",
          turnId: TurnId.make("turn-1"),
          streaming: true,
        },
      ],
    };

    expect(threadListener).toBeDefined();
    threadListener!({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 2,
        thread: fullThread,
      },
    });

    const hydratedState = useStore.getState().environmentStateById[environmentId];
    expect(hydratedState?.messageByThreadId[threadId]?.[messageId]?.text).toBe(
      "После правки body поднялся с середины (`~425px`) до нормальной позиции.",
    );

    threadListener!({
      kind: "event",
      event: makeThreadMessageSentEvent({
        sequence: 3,
        threadId,
        messageId,
        text: " Ещё быстро проверю Raw view.",
        streaming: true,
      }),
    });

    const liveState = useStore.getState().environmentStateById[environmentId];
    expect(liveState?.messageByThreadId[threadId]?.[messageId]?.text).toBe(
      "После правки body поднялся с середины (`~425px`) до нормальной позиции. Ещё быстро проверю Raw view.",
    );

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });
});
