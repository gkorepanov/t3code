import {
  type AuthSessionRole,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationEventDeltaStreamItem,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type PersistedSavedEnvironmentRecord,
  type ServerConfig,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import { type QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  createKnownEnvironment,
  getKnownEnvironmentWsBaseUrl,
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { ensureLocalApi } from "~/localApi";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import { getPrimaryKnownEnvironment } from "../primary";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl,
} from "../remote/api";
import { resolveRemotePairingTarget } from "../remote/target";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import { WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
} from "../../logicalProject";
import { getClientSettings } from "~/hooks/useSettings";
import type { Thread } from "~/types";
import {
  clearCachedThreadDetailsForEnvironment,
  deleteCachedThreadDetail,
  persistCachedAppliedState,
  readCachedEnvironmentState,
  touchCachedThreadDetail,
} from "./orchestrationStateCache";

type EnvironmentServiceState = {
  readonly queryClient: QueryClient;
  readonly queryInvalidationThrottler: Throttler<() => void>;
  refCount: number;
  stop: () => void;
};

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
};

const environmentConnections = new Map<EnvironmentId, EnvironmentConnection>();
const environmentConnectionListeners = new Set<() => void>();
const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
const lastAppliedProjectionVersionByEnvironment = new Map<
  EnvironmentId,
  {
    readonly sequence: number;
    readonly updatedAt: string | null;
  }
>();
const cachedShellSnapshotByEnvironment = new Map<EnvironmentId, OrchestrationShellSnapshot>();
const threadDetailVersionByKey = new Map<string, number>();
const pendingDeltaReplayByEnvironment = new Set<EnvironmentId>();
const pendingDeltaApplyByEnvironment = new Map<
  EnvironmentId,
  {
    items: Array<Extract<OrchestrationEventDeltaStreamItem, { kind: "event" | "event-batch" }>>;
    eventCount: number;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }
>();
const pendingCachePersistByEnvironment = new Map<
  EnvironmentId,
  {
    shell: OrchestrationShellSnapshot | null;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }
>();
const pendingThreadDetailEventsByKey = new Map<string, OrchestrationEvent[]>();
const lastCachePersistAtByEnvironment = new Map<EnvironmentId, number>();

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;

// Thread detail subscription cache policy:
// - Active consumers keep a subscription retained via refCount.
// - Released subscriptions stay warm for a longer idle TTL to avoid churn
//   while moving around the UI.
// - Threads with active work or pending user action are sticky and are never
//   evicted while they remain non-idle.
// - Capacity eviction only targets idle cached subscriptions.
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const DELTA_APPLY_IDLE_FLUSH_MS = 50;
const MAX_PENDING_DELTA_APPLY_EVENTS = 500;
const CACHE_PERSIST_MIN_INTERVAL_MS = 5_000;
const NOOP = () => undefined;

function compareAppliedProjectionVersion(
  left: { readonly sequence: number; readonly updatedAt: string | null },
  right: { readonly sequence: number; readonly updatedAt: string | null },
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const leftUpdatedAt = left.updatedAt ?? "";
  const rightUpdatedAt = right.updatedAt ?? "";
  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  return leftUpdatedAt < rightUpdatedAt ? -1 : 1;
}

function toAppliedProjectionVersion(
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): {
  readonly sequence: number;
  readonly updatedAt: string;
} {
  return {
    sequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
  };
}

export function shouldApplyProjectionSnapshot(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly next: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return compareAppliedProjectionVersion(input.current, toAppliedProjectionVersion(input.next)) < 0;
}

export function shouldApplyProjectionEvent(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly sequence: number;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return input.sequence > input.current.sequence;
}

function readLastAppliedProjectionVersion(environmentId: EnvironmentId): {
  readonly sequence: number;
  readonly updatedAt: string | null;
} | null {
  return lastAppliedProjectionVersionByEnvironment.get(environmentId) ?? null;
}

function markAppliedProjectionSnapshot(
  environmentId: EnvironmentId,
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): void {
  const nextVersion = toAppliedProjectionVersion(snapshot);
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (
    currentVersion !== null &&
    compareAppliedProjectionVersion(currentVersion, nextVersion) >= 0
  ) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, nextVersion);
}

function markAppliedProjectionEvent(environmentId: EnvironmentId, sequence: number): void {
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (currentVersion !== null && sequence <= currentVersion.sequence) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, {
    sequence,
    updatedAt: currentVersion?.updatedAt ?? null,
  });
}

function readAppliedSequence(environmentId: EnvironmentId): number | null {
  return readLastAppliedProjectionVersion(environmentId)?.sequence ?? null;
}

function requestDeltaReplay(environmentId: EnvironmentId): void {
  if (pendingDeltaReplayByEnvironment.has(environmentId)) {
    return;
  }

  pendingDeltaReplayByEnvironment.add(environmentId);
  queueMicrotask(() => {
    const connection = readEnvironmentConnection(environmentId);
    if (!connection) {
      pendingDeltaReplayByEnvironment.delete(environmentId);
      return;
    }

    void connection
      .refreshEvents()
      .catch(() => undefined)
      .finally(() => {
        pendingDeltaReplayByEnvironment.delete(environmentId);
      });
  });
}

function getThreadDetailSubscriptionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function readThreadDetailVersion(environmentId: EnvironmentId, threadId: ThreadId): number | null {
  return (
    threadDetailVersionByKey.get(getThreadDetailSubscriptionKey(environmentId, threadId)) ?? null
  );
}

function markThreadDetailVersion(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sequence: number,
): void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const currentSequence = threadDetailVersionByKey.get(key);
  if (currentSequence !== undefined && sequence <= currentSequence) {
    return;
  }
  threadDetailVersionByKey.set(key, sequence);
}

function clearThreadDetailVersion(environmentId: EnvironmentId, threadId: ThreadId): void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  threadDetailVersionByKey.delete(key);
  pendingThreadDetailEventsByKey.delete(key);
}

function clearThreadDetailVersionsForEnvironment(environmentId: EnvironmentId): void {
  for (const key of threadDetailVersionByKey.keys()) {
    if (key.startsWith(`${environmentId}:`)) {
      threadDetailVersionByKey.delete(key);
    }
  }
  for (const key of pendingThreadDetailEventsByKey.keys()) {
    if (key.startsWith(`${environmentId}:`)) {
      pendingThreadDetailEventsByKey.delete(key);
    }
  }
}

function replaceShellItem<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  nextItem: T,
): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  const nextItems = [...items];
  nextItems[existingIndex] = nextItem;
  return nextItems;
}

function removeShellItem<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  itemId: string,
): T[] {
  return items.filter((item) => item.id !== itemId);
}

function updateCachedShellSnapshot(
  environmentId: EnvironmentId,
  sequence: number,
  shellEvent?: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot | null {
  const snapshot = cachedShellSnapshotByEnvironment.get(environmentId);
  if (!snapshot || sequence < snapshot.snapshotSequence) {
    return snapshot ?? null;
  }

  let projects = snapshot.projects;
  let threads = snapshot.threads;
  switch (shellEvent?.kind) {
    case "project-upserted":
      projects = replaceShellItem(projects, shellEvent.project);
      break;
    case "project-removed":
      projects = removeShellItem(projects, shellEvent.projectId);
      break;
    case "thread-upserted":
      threads = replaceShellItem(threads, shellEvent.thread);
      break;
    case "thread-removed":
      threads = removeShellItem(threads, shellEvent.threadId);
      break;
    case undefined:
      break;
  }

  const nextSnapshot: OrchestrationShellSnapshot = {
    ...snapshot,
    snapshotSequence: sequence,
    projects,
    threads,
    updatedAt: new Date().toISOString(),
  };
  cachedShellSnapshotByEnvironment.set(environmentId, nextSnapshot);
  return nextSnapshot;
}

function getEventThreadId(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function isThreadDetailDeltaEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function collectCachedThreadDetailsForCheckpoint(
  environmentId: EnvironmentId,
  sequence: number,
): Array<{ threadId: ThreadId; sequence: number; thread: Thread }> {
  const state = useStore.getState();
  const threadDetails: Array<{ threadId: ThreadId; sequence: number; thread: Thread }> = [];

  for (const key of threadDetailVersionByKey.keys()) {
    const threadRef = parseScopedThreadKey(key);
    if (!threadRef || threadRef.environmentId !== environmentId) {
      continue;
    }

    const thread = selectThreadByRef(state, threadRef);
    if (!thread) {
      clearThreadDetailVersion(environmentId, threadRef.threadId);
      continue;
    }

    threadDetails.push({
      threadId: threadRef.threadId,
      sequence,
      thread,
    });
  }

  return threadDetails;
}

function flushPendingCachePersist(environmentId: EnvironmentId): void {
  const pending = pendingCachePersistByEnvironment.get(environmentId);
  if (!pending) {
    return;
  }

  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
  }
  pendingCachePersistByEnvironment.delete(environmentId);
  lastCachePersistAtByEnvironment.set(environmentId, Date.now());

  const shell = pending.shell ?? cachedShellSnapshotByEnvironment.get(environmentId) ?? null;
  if (!shell) {
    return;
  }

  void persistCachedAppliedState({
    environmentId,
    shell,
    threadDetails: collectCachedThreadDetailsForCheckpoint(environmentId, shell.snapshotSequence),
  }).catch(() => undefined);
}

function schedulePendingCachePersist(environmentId: EnvironmentId): void {
  const pending = pendingCachePersistByEnvironment.get(environmentId);
  if (!pending || pending.timeoutId !== null) {
    return;
  }

  const lastPersistedAt = lastCachePersistAtByEnvironment.get(environmentId) ?? 0;
  const delayMs = Math.max(0, CACHE_PERSIST_MIN_INTERVAL_MS - (Date.now() - lastPersistedAt));
  if (delayMs === 0) {
    flushPendingCachePersist(environmentId);
    return;
  }

  pending.timeoutId = setTimeout(() => {
    const currentPending = pendingCachePersistByEnvironment.get(environmentId);
    if (currentPending) {
      currentPending.timeoutId = null;
    }
    flushPendingCachePersist(environmentId);
  }, delayMs);
}

function queueAppliedCachePersist(input: {
  readonly environmentId: EnvironmentId;
  readonly sequence: number;
  readonly threadId?: ThreadId | null;
}): void {
  const shell = cachedShellSnapshotByEnvironment.get(input.environmentId) ?? null;
  const thread =
    input.threadId && readThreadDetailVersion(input.environmentId, input.threadId) !== null
      ? selectThreadByRef(useStore.getState(), scopeThreadRef(input.environmentId, input.threadId))
      : null;

  if (!shell || (thread && shell.snapshotSequence < input.sequence)) {
    return;
  }

  const pending = pendingCachePersistByEnvironment.get(input.environmentId) ?? {
    shell: null,
    timeoutId: null,
  };
  pending.shell = shell;
  pendingCachePersistByEnvironment.set(input.environmentId, pending);
  schedulePendingCachePersist(input.environmentId);
}

function deleteCachedThreadDetailState(environmentId: EnvironmentId, threadId: ThreadId): void {
  clearThreadDetailVersion(environmentId, threadId);
  void deleteCachedThreadDetail(environmentId, threadId).catch(() => undefined);
}

function clearThreadDetailSubscriptionEviction(
  entry: ThreadDetailSubscriptionEntry,
): ThreadDetailSubscriptionEntry {
  if (entry.evictionTimeoutId !== null) {
    clearTimeout(entry.evictionTimeoutId);
    entry.evictionTimeoutId = null;
  }
  return entry;
}

function isNonIdleThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function shouldEvictThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  return entry.refCount === 0 && !isNonIdleThreadDetailSubscription(entry);
}

function attachThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    return true;
  }

  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }

  if (readThreadDetailVersion(entry.environmentId, entry.threadId) !== null) {
    void touchCachedThreadDetail(entry.environmentId, entry.threadId).catch(() => undefined);
  }

  entry.unsubscribe = connection.client.orchestration.subscribeThread(
    { threadId: entry.threadId },
    (item) => {
      if (item.kind === "snapshot") {
        const currentVersion = readThreadDetailVersion(entry.environmentId, entry.threadId);
        if (currentVersion !== null && item.snapshot.snapshotSequence < currentVersion) {
          return;
        }
        useStore.getState().syncServerThreadDetail(item.snapshot.thread, entry.environmentId);
        markThreadDetailVersion(
          entry.environmentId,
          entry.threadId,
          item.snapshot.snapshotSequence,
        );
        drainPendingThreadDetailEvents(
          entry.environmentId,
          entry.threadId,
          item.snapshot.snapshotSequence,
        );
        queueAppliedCachePersist({
          environmentId: entry.environmentId,
          sequence: item.snapshot.snapshotSequence,
          threadId: entry.threadId,
        });
        return;
      }

      if (item.kind === "event") {
        const currentVersion = readThreadDetailVersion(entry.environmentId, entry.threadId);
        if (currentVersion === null) {
          queuePendingThreadDetailEvent(entry.environmentId, item.event);
          return;
        }
        if (item.event.sequence <= currentVersion) {
          return;
        }

        applyEnvironmentThreadDetailEvent(item.event, entry.environmentId);
        markThreadDetailVersion(entry.environmentId, entry.threadId, item.event.sequence);
        queueAppliedCachePersist({
          environmentId: entry.environmentId,
          sequence: item.event.sequence,
          threadId: entry.threadId,
        });
      }
    },
  );
  return true;
}

function watchThreadDetailSubscriptionConnection(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }

  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    if (attachThreadDetailSubscription(entry)) {
      entry.lastAccessedAt = Date.now();
    }
  });
  attachThreadDetailSubscription(entry);
}

function disposeThreadDetailSubscriptionByKey(key: string): boolean {
  const entry = threadDetailSubscriptions.get(key);
  if (!entry) {
    return false;
  }

  clearThreadDetailSubscriptionEviction(entry);
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  threadDetailSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  return true;
}

function disposeThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function reconcileThreadDetailSubscriptionsForEnvironment(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  const activeThreadIds = new Set(threadIds);
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function scheduleThreadDetailSubscriptionEviction(entry: ThreadDetailSubscriptionEntry): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  entry.evictionTimeoutId = setTimeout(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }

    currentEntry.evictionTimeoutId = null;
    if (!shouldEvictThreadDetailSubscription(currentEntry)) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
  }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
}

function evictIdleThreadDetailSubscriptionsToCapacity(): void {
  if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...threadDetailSubscriptions.entries()]
    .filter(([, entry]) => shouldEvictThreadDetailSubscription(entry))
    .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);

  for (const [key] of idleEntries) {
    if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(key);
  }
}

function reconcileThreadDetailSubscriptionEvictionState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  scheduleThreadDetailSubscriptionEviction(entry);
}

function reconcileThreadDetailSubscriptionEvictionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry) {
    return;
  }

  reconcileThreadDetailSubscriptionEvictionState(entry);
}

function reconcileThreadDetailSubscriptionEvictionForEnvironment(
  environmentId: EnvironmentId,
): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
    }
  }
  evictIdleThreadDetailSubscriptionsToCapacity();
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const existing = threadDetailSubscriptions.get(key);
  if (existing) {
    clearThreadDetailSubscriptionEviction(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    if (!attachThreadDetailSubscription(existing)) {
      watchThreadDetailSubscriptionConnection(existing);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      existing.refCount = Math.max(0, existing.refCount - 1);
      existing.lastAccessedAt = Date.now();
      if (existing.refCount === 0) {
        reconcileThreadDetailSubscriptionEvictionState(existing);
        evictIdleThreadDetailSubscriptionsToCapacity();
      }
    };
  }

  const entry: ThreadDetailSubscriptionEntry = {
    environmentId,
    threadId,
    unsubscribe: NOOP,
    unsubscribeConnectionListener: null,
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeoutId: null,
  };
  threadDetailSubscriptions.set(key, entry);
  if (!attachThreadDetailSubscription(entry)) {
    watchThreadDetailSubscriptionConnection(entry);
  }
  evictIdleThreadDetailSubscriptionsToCapacity();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastAccessedAt = Date.now();
    if (entry.refCount === 0) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
      evictIdleThreadDetailSubscriptionsToCapacity();
    }
  };
}

function emitEnvironmentConnectionRegistryChange() {
  for (const listener of environmentConnectionListeners) {
    listener();
  }
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  } as const;
}

function isoNow(): string {
  return new Date().toISOString();
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  const connectedAt = isoNow();
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, connectedAt);
}

function setRuntimeDisconnected(environmentId: EnvironmentId, reason?: string | null) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "disconnected",
    disconnectedAt: isoNow(),
    ...(reason && reason.trim().length > 0
      ? {
          lastError: reason,
          lastErrorAt: isoNow(),
        }
      : {}),
  });
}

function setRuntimeError(environmentId: EnvironmentId, error: unknown) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "error",
    ...getRuntimeErrorFields(error),
  });
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
}

function syncThreadUiFromStore() {
  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}

function reconcileSnapshotDerivedState() {
  syncProjectUiFromStore();
  syncThreadUiFromStore();

  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  const activeThreadKeys = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
  });
  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
}

export function shouldApplyTerminalEvent(input: {
  serverThreadArchivedAt: string | null | undefined;
  hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    needsProviderInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId);
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    const clientSettings = getClientSettings();
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: derivePhysicalProjectKey(project),
        logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
        cwd: project.cwd,
      })),
    );
  }

  const needsThreadUiSync = events.some(
    (event) => event.type === "thread.created" || event.type === "thread.deleted",
  );
  if (needsThreadUiSync) {
    const threads = selectThreadsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
  }

  const draftStore = useComposerDraftStore.getState();
  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    draftStore.clearDraftThread(scopeThreadRef(environmentId, threadId));
    useUiStateStore
      .getState()
      .clearThreadUi(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  }
  for (const event of events) {
    if (event.type === "project.deleted") {
      draftStore.clearProjectDraftThreadId(scopeProjectRef(environmentId, event.payload.projectId));
    }
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    useTerminalStateStore.getState().removeTerminalState(scopeThreadRef(environmentId, threadId));
  }

  reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  applyRecoveredEventBatch([event], environmentId);
}

function applyShellProjectionEvent(
  event: OrchestrationShellStreamEvent,
  environmentId: EnvironmentId,
) {
  const threadId =
    event.kind === "thread-upserted"
      ? event.thread.id
      : event.kind === "thread-removed"
        ? event.threadId
        : null;
  const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
  const previousThread = threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined;

  useStore.getState().applyShellEvent(event, environmentId);

  switch (event.kind) {
    case "project-upserted":
    case "project-removed":
      syncProjectUiFromStore();
      return;
    case "thread-upserted":
      syncThreadUiFromStore();
      if (!previousThread && threadRef) {
        markPromotedDraftThreadByRef(threadRef);
      }
      if (previousThread?.archivedAt === null && event.thread.archivedAt !== null && threadRef) {
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      reconcileThreadDetailSubscriptionEvictionForThread(environmentId, event.thread.id);
      evictIdleThreadDetailSubscriptionsToCapacity();
      return;
    case "thread-removed":
      if (threadRef) {
        disposeThreadDetailSubscriptionByKey(scopedThreadKey(threadRef));
        deleteCachedThreadDetailState(environmentId, event.threadId);
        useComposerDraftStore.getState().clearDraftThread(threadRef);
        useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      syncThreadUiFromStore();
      return;
  }
}

function applyShellEvent(event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) {
  if (
    !shouldApplyProjectionEvent({
      current: readLastAppliedProjectionVersion(environmentId),
      sequence: event.sequence,
    })
  ) {
    return;
  }

  applyShellProjectionEvent(event, environmentId);
  updateCachedShellSnapshot(environmentId, event.sequence, event);
  queueAppliedCachePersist({
    environmentId,
    sequence: event.sequence,
  });
  markAppliedProjectionEvent(environmentId, event.sequence);
}

function resetThreadDetailCacheForEnvironment(environmentId: EnvironmentId): void {
  clearThreadDetailVersionsForEnvironment(environmentId);
  useStore.getState().clearEnvironmentThreadDetails(environmentId);
  void clearCachedThreadDetailsForEnvironment(environmentId).catch(() => undefined);

  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId !== environmentId) {
      continue;
    }
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
    if (entry.refCount > 0 && !attachThreadDetailSubscription(entry)) {
      watchThreadDetailSubscriptionConnection(entry);
    }
  }
}

function syncShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
  options?: {
    readonly persist?: boolean;
    readonly invalidateThreadDetailsOnGap?: boolean;
  },
): void {
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (
    !shouldApplyProjectionSnapshot({
      current: currentVersion,
      next: snapshot,
    })
  ) {
    return;
  }

  if (
    options?.invalidateThreadDetailsOnGap !== false &&
    currentVersion !== null &&
    snapshot.snapshotSequence > currentVersion.sequence
  ) {
    resetThreadDetailCacheForEnvironment(environmentId);
  }

  useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
  cachedShellSnapshotByEnvironment.set(environmentId, snapshot);
  markAppliedProjectionSnapshot(environmentId, snapshot);
  if (options?.persist !== false) {
    queueAppliedCachePersist({
      environmentId,
      sequence: snapshot.snapshotSequence,
    });
  }
  reconcileThreadDetailSubscriptionsForEnvironment(
    environmentId,
    snapshot.threads.map((thread) => thread.id),
  );
  reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
  reconcileSnapshotDerivedState();
}

async function hydrateCachedEnvironmentState(environmentId: EnvironmentId): Promise<void> {
  const cachedState = await readCachedEnvironmentState(environmentId);
  if (!cachedState.shell) {
    return;
  }

  syncShellSnapshot(cachedState.shell, environmentId, {
    persist: false,
    invalidateThreadDetailsOnGap: false,
  });

  const shellThreadIds = new Set(cachedState.shell.threads.map((thread) => thread.id));
  for (const record of cachedState.threads) {
    if (
      !shellThreadIds.has(record.threadId) ||
      record.sequence !== cachedState.shell.snapshotSequence
    ) {
      deleteCachedThreadDetailState(environmentId, record.threadId);
      continue;
    }
    useStore.getState().syncCachedThreadDetail(record.thread);
    markThreadDetailVersion(environmentId, record.threadId, record.sequence);
  }
}

type DeltaApplyItem = Extract<OrchestrationEventDeltaStreamItem, { kind: "event" | "event-batch" }>;
type DeltaEventEntry = {
  readonly event: OrchestrationEvent;
  readonly shellEvent?: OrchestrationShellStreamEvent | undefined;
};

function getDeltaApplyItemEventCount(item: DeltaApplyItem): number {
  return item.kind === "event" ? 1 : item.events.length;
}

function flattenDeltaApplyItems(items: ReadonlyArray<DeltaApplyItem>): DeltaEventEntry[] {
  return items.flatMap((item) =>
    item.kind === "event"
      ? [
          {
            event: item.event,
            ...(item.shellEvent ? { shellEvent: item.shellEvent } : {}),
          },
        ]
      : item.events,
  );
}

function queuePendingThreadDetailEvent(environmentId: EnvironmentId, event: OrchestrationEvent) {
  const threadId = getEventThreadId(event);
  if (!threadId) {
    return;
  }

  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const pending = pendingThreadDetailEventsByKey.get(key) ?? [];
  if (pending.some((entry) => entry.sequence === event.sequence)) {
    return;
  }
  pendingThreadDetailEventsByKey.set(key, [...pending, event]);
}

function drainPendingThreadDetailEvents(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  afterSequence: number,
) {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const pending = pendingThreadDetailEventsByKey.get(key);
  if (!pending) {
    return;
  }

  pendingThreadDetailEventsByKey.delete(key);
  const freshEvents = pending
    .filter((event) => event.sequence > afterSequence)
    .toSorted((left, right) => left.sequence - right.sequence);
  if (freshEvents.length === 0) {
    return;
  }

  applyRecoveredEventBatch(freshEvents, environmentId);

  const lastSequence = freshEvents[freshEvents.length - 1]!.sequence;
  markThreadDetailVersion(environmentId, threadId, lastSequence);
  queueAppliedCachePersist({
    environmentId,
    sequence: lastSequence,
    threadId,
  });
}

function shouldApplyGlobalDeltaEventToDetail(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  const threadId = getEventThreadId(event);
  if (!threadId || !isThreadDetailDeltaEvent(event)) {
    return true;
  }

  const hasRetainedThreadDetail = threadDetailSubscriptions.has(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!hasRetainedThreadDetail) {
    return true;
  }

  if (readThreadDetailVersion(environmentId, threadId) === null) {
    queuePendingThreadDetailEvent(environmentId, event);
  }
  return false;
}

function flushPendingDeltaEvents(environmentId: EnvironmentId): void {
  const pending = pendingDeltaApplyByEnvironment.get(environmentId);
  if (!pending) {
    return;
  }

  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
  }
  pendingDeltaApplyByEnvironment.delete(environmentId);
  applyDeltaItemsNow(pending.items, environmentId);
}

function applyDeltaEvent(item: DeltaApplyItem, environmentId: EnvironmentId): void {
  const pending = pendingDeltaApplyByEnvironment.get(environmentId) ?? {
    items: [],
    eventCount: 0,
    timeoutId: null,
  };
  pending.items.push(item);
  pending.eventCount += getDeltaApplyItemEventCount(item);
  if (pending.timeoutId !== null) {
    clearTimeout(pending.timeoutId);
  }

  pendingDeltaApplyByEnvironment.set(environmentId, pending);
  if (pending.eventCount >= MAX_PENDING_DELTA_APPLY_EVENTS) {
    flushPendingDeltaEvents(environmentId);
    return;
  }

  pending.timeoutId = setTimeout(() => {
    const currentPending = pendingDeltaApplyByEnvironment.get(environmentId);
    if (currentPending) {
      currentPending.timeoutId = null;
    }
    flushPendingDeltaEvents(environmentId);
  }, DELTA_APPLY_IDLE_FLUSH_MS);
}

function applyDeltaItemsNow(items: ReadonlyArray<DeltaApplyItem>, environmentId: EnvironmentId) {
  const deltaEvents = flattenDeltaApplyItems(items);
  if (deltaEvents.length === 0) {
    return;
  }

  const currentSequence = readAppliedSequence(environmentId);
  const freshDeltaEvents =
    currentSequence === null
      ? deltaEvents
      : deltaEvents.filter((item) => item.event.sequence > currentSequence);
  if (freshDeltaEvents.length === 0) {
    return;
  }

  let expectedSequence = currentSequence ?? 0;
  for (const item of freshDeltaEvents) {
    if (item.event.sequence !== expectedSequence + 1) {
      requestDeltaReplay(environmentId);
      return;
    }
    expectedSequence = item.event.sequence;
  }

  applyRecoveredEventBatch(
    freshDeltaEvents
      .map((deltaEvent) => deltaEvent.event)
      .filter((event) => shouldApplyGlobalDeltaEventToDetail(event, environmentId)),
    environmentId,
  );

  for (const item of freshDeltaEvents) {
    if (item.shellEvent) {
      applyShellProjectionEvent(item.shellEvent, environmentId);
    }
    updateCachedShellSnapshot(environmentId, item.event.sequence, item.shellEvent);
  }

  for (const item of freshDeltaEvents) {
    const threadId = getEventThreadId(item.event);
    if (!threadId) {
      continue;
    }
    if (item.event.type === "thread.deleted") {
      deleteCachedThreadDetailState(environmentId, threadId);
      continue;
    }
  }

  const lastSequence = freshDeltaEvents[freshDeltaEvents.length - 1]!.event.sequence;
  for (const key of threadDetailVersionByKey.keys()) {
    const threadRef = parseScopedThreadKey(key);
    if (
      threadRef?.environmentId === environmentId &&
      readThreadDetailVersion(environmentId, threadRef.threadId) !== null
    ) {
      markThreadDetailVersion(environmentId, threadRef.threadId, lastSequence);
    }
  }
  queueAppliedCachePersist({
    environmentId,
    sequence: lastSequence,
  });
  markAppliedProjectionEvent(environmentId, lastSequence);
}

function markCaughtUp(sequence: number, environmentId: EnvironmentId): boolean {
  flushPendingDeltaEvents(environmentId);
  schedulePendingCachePersist(environmentId);
  const currentSequence = readAppliedSequence(environmentId);
  if (currentSequence !== null && sequence <= currentSequence) {
    return true;
  }
  if (currentSequence === null && sequence === 0) {
    markAppliedProjectionEvent(environmentId, sequence);
    return true;
  }

  requestDeltaReplay(environmentId);
  return false;
}

function createEnvironmentConnectionHandlers() {
  return {
    applyShellEvent,
    applyDeltaEvent,
    markCaughtUp,
    readAppliedSequence,
    hydrateCachedState: hydrateCachedEnvironmentState,
    syncShellSnapshot,
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const serverThread = selectThreadByRef(useStore.getState(), threadRef);
      const hasDraftThread =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (
        !shouldApplyTerminalEvent({
          serverThreadArchivedAt: serverThread?.archivedAt,
          hasDraftThread,
        })
      ) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }

  return createWsRpcClient(new WsTransport(wsBaseUrl));
}

function createSavedEnvironmentClient(
  record: SavedEnvironmentRecord,
  bearerToken: string,
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(record.environmentId);

  return createWsRpcClient(
    new WsTransport(
      () =>
        resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: record.wsBaseUrl,
          httpBaseUrl: record.httpBaseUrl,
          bearerToken,
        }),
      {
        onAttempt: () => {
          setRuntimeConnecting(record.environmentId);
        },
        onOpen: () => {
          setRuntimeConnected(record.environmentId);
        },
        onError: (message: string) => {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            connectionState: "error",
            lastError: message,
            lastErrorAt: isoNow(),
          });
        },
        onClose: (details: { readonly code: number; readonly reason: string }) => {
          setRuntimeDisconnected(record.environmentId, details.reason);
        },
      },
    ),
  );
}

async function refreshSavedEnvironmentMetadata(
  record: SavedEnvironmentRecord,
  bearerToken: string,
  client: WsRpcClient,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  let sessionState = await fetchRemoteSessionState({
    httpBaseUrl: record.httpBaseUrl,
    bearerToken,
  });
  if (!sessionState.authenticated && window.desktopBridge?.openAuthWindow) {
    const opened = await window.desktopBridge.openAuthWindow(record.httpBaseUrl);
    if (opened) {
      sessionState = await fetchRemoteSessionState({
        httpBaseUrl: record.httpBaseUrl,
        bearerToken,
      });
    }
  }
  if (!sessionState.authenticated) {
    throw new Error("Remote environment requires authentication.");
  }
  const serverConfig = configHint
    ? await Promise.resolve(configHint)
    : await client.server.getConfig();

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: "authenticated",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.role ?? roleHint ?? null,
  });
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  const existing = environmentConnections.get(connection.environmentId);
  if (existing && existing !== connection) {
    throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
  }
  environmentConnections.set(connection.environmentId, connection);
  emitEnvironmentConnectionRegistryChange();
  return connection;
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    return false;
  }

  disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  flushPendingDeltaEvents(environmentId);
  flushPendingCachePersist(environmentId);
  lastAppliedProjectionVersionByEnvironment.delete(environmentId);
  cachedShellSnapshotByEnvironment.delete(environmentId);
  clearThreadDetailVersionsForEnvironment(environmentId);
  environmentConnections.delete(environmentId);
  emitEnvironmentConnectionRegistryChange();
  await connection.dispose();
  return true;
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }

  const existing = environmentConnections.get(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      ...createEnvironmentConnectionHandlers(),
    }),
  );
}

async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<EnvironmentConnection> {
  const existing = environmentConnections.get(record.environmentId);
  if (existing) {
    return existing;
  }

  const bearerToken =
    options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
  if (!bearerToken) {
    useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
      authState: "requires-auth",
      role: null,
      connectionState: "disconnected",
      lastError: "Saved environment is missing its saved credential. Pair it again.",
      lastErrorAt: isoNow(),
    });
    throw new Error("Saved environment is missing its saved credential.");
  }

  const client = options?.client ?? createSavedEnvironmentClient(record, bearerToken);
  const knownEnvironment = createKnownEnvironment({
    id: record.environmentId,
    label: record.label,
    source: "manual",
    target: {
      httpBaseUrl: record.httpBaseUrl,
      wsBaseUrl: record.wsBaseUrl,
    },
  });
  const connection = createEnvironmentConnection({
    kind: "saved",
    knownEnvironment: {
      ...knownEnvironment,
      environmentId: record.environmentId,
    },
    client,
    refreshMetadata: async () => {
      await refreshSavedEnvironmentMetadata(record, bearerToken, client);
    },
    onConfigSnapshot: (config) => {
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: config.environment,
        serverConfig: config,
      });
    },
    onWelcome: (payload) => {
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: payload.environment,
      });
    },
    ...createEnvironmentConnectionHandlers(),
  });

  registerConnection(connection);

  try {
    await refreshSavedEnvironmentMetadata(
      record,
      bearerToken,
      client,
      options?.role ?? null,
      options?.serverConfig ?? null,
    );
    return connection;
  } catch (error) {
    setRuntimeError(record.environmentId, error);
    await removeConnection(record.environmentId).catch(() => false);
    throw error;
  }
}

async function syncSavedEnvironmentConnections(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Promise<void> {
  const expectedEnvironmentIds = new Set(records.map((record) => record.environmentId));
  const staleEnvironmentIds = [...environmentConnections.values()]
    .filter((connection) => connection.kind === "saved")
    .map((connection) => connection.environmentId)
    .filter((environmentId) => !expectedEnvironmentIds.has(environmentId));

  await Promise.all(
    staleEnvironmentIds.map((environmentId) => disconnectSavedEnvironment(environmentId)),
  );
  await Promise.all(
    records.map((record) => ensureSavedEnvironmentConnection(record).catch(() => undefined)),
  );
}

function stopActiveService() {
  activeService?.stop();
  activeService = null;
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return [...environmentConnections.values()];
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return environmentConnections.get(environmentId) ?? null;
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const connection = environmentConnections.get(environmentId);
  if (connection?.kind !== "saved") {
    return;
  }

  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  await removeConnection(environmentId).catch(() => false);
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }

  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    await ensureSavedEnvironmentConnection(record);
    return;
  }

  setRuntimeConnecting(environmentId);
  try {
    await connection.reconnect();
  } catch (error) {
    setRuntimeError(environmentId, error);
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
  await disconnectSavedEnvironment(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  const fetchDescriptor = () =>
    fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: resolvedTarget.httpBaseUrl,
    });
  const descriptor = await fetchDescriptor().catch(async (error) => {
    if (
      !window.desktopBridge?.openAuthWindow ||
      !(error instanceof Error) ||
      !error.message.includes("Failed to fetch remote auth endpoint")
    ) {
      throw error;
    }
    const opened = await window.desktopBridge.openAuthWindow(resolvedTarget.httpBaseUrl);
    if (!opened) {
      throw error;
    }
    return fetchDescriptor();
  });
  const environmentId = descriptor.environmentId;

  if (environmentConnections.has(environmentId)) {
    throw new Error("This environment is already connected.");
  }

  const bearerSession = await bootstrapRemoteBearerSession({
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    credential: resolvedTarget.credential,
  });

  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || descriptor.label,
    wsBaseUrl: resolvedTarget.wsBaseUrl,
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    createdAt: isoNow(),
    lastConnectedAt: isoNow(),
  };

  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
      listSavedEnvironmentRecords().map((entry) => {
        const record: PersistedSavedEnvironmentRecord = {
          environmentId: entry.environmentId,
          label: entry.label,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          createdAt: entry.createdAt,
          lastConnectedAt: entry.lastConnectedAt,
        };
        if (entry.editorRemoteHost) {
          record.editorRemoteHost = entry.editorRemoteHost;
        }
        return record;
      }),
    );
    throw new Error("Unable to persist saved environment credentials.");
  }
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  return record;
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await environmentConnections.get(environmentId)?.ensureBootstrapped();
}

export function startEnvironmentConnectionService(queryClient: QueryClient): () => void {
  if (activeService?.queryClient === queryClient) {
    activeService.refCount += 1;
    return () => {
      if (!activeService || activeService.queryClient !== queryClient) {
        return;
      }
      activeService.refCount -= 1;
      if (activeService.refCount === 0) {
        stopActiveService();
      }
    };
  }

  stopActiveService();
  needsProviderInvalidation = false;
  const queryInvalidationThrottler = new Throttler(
    () => {
      if (!needsProviderInvalidation) {
        return;
      }
      needsProviderInvalidation = false;
      void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );

  createPrimaryEnvironmentConnection();

  const unsubscribeSavedEnvironments = useSavedEnvironmentRegistryStore.subscribe(() => {
    if (!hasSavedEnvironmentRegistryHydrated()) {
      return;
    }
    void syncSavedEnvironmentConnections(listSavedEnvironmentRecords());
  });

  void waitForSavedEnvironmentRegistryHydration()
    .then(() => syncSavedEnvironmentConnections(listSavedEnvironmentRecords()))
    .catch(() => undefined);

  activeService = {
    queryClient,
    queryInvalidationThrottler,
    refCount: 1,
    stop: () => {
      unsubscribeSavedEnvironments();
      queryInvalidationThrottler.cancel();
    },
  };

  return () => {
    if (!activeService || activeService.queryClient !== queryClient) {
      return;
    }
    activeService.refCount -= 1;
    if (activeService.refCount === 0) {
      stopActiveService();
    }
  };
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  stopActiveService();
  lastAppliedProjectionVersionByEnvironment.clear();
  cachedShellSnapshotByEnvironment.clear();
  threadDetailVersionByKey.clear();
  pendingDeltaReplayByEnvironment.clear();
  pendingDeltaApplyByEnvironment.clear();
  pendingCachePersistByEnvironment.clear();
  pendingThreadDetailEventsByKey.clear();
  lastCachePersistAtByEnvironment.clear();
  for (const key of Array.from(threadDetailSubscriptions.keys())) {
    disposeThreadDetailSubscriptionByKey(key);
  }
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
}
