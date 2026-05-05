import { useEffect, useMemo, useRef } from "react";

import type { AppState } from "../store";
import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { showAgentTurnSystemNotification } from "../lib/agentNotifications";

const AGENT_NOTIFICATIONS_SCOPE = "[AGENT_NOTIFICATIONS]";
const NOTIFICATION_FRESHNESS_GRACE_MS = 5_000;

type AgentTurnNotificationStatus = "completed" | "failed";

interface AgentTurnSnapshot {
  key: string;
  threadTitle: string;
  sessionStatus: string | null;
  sessionUpdatedAt: string | null;
  activeTurnId: string | null;
  latestTurnId: string | null;
  latestTurnState: string | null;
  latestTurnCompletedAt: string | null;
}

interface AgentTurnNotificationCandidate {
  dedupeKey: string;
  status: AgentTurnNotificationStatus;
  threadTitle: string;
}

function selectAgentTurnSnapshots(
  environmentStateById: AppState["environmentStateById"],
): AgentTurnSnapshot[] {
  return Object.entries(environmentStateById).flatMap(([environmentId, environmentState]) => {
    if (!environmentState.bootstrapComplete) return [];

    return environmentState.threadIds.flatMap((threadId) => {
      const thread = environmentState.threadShellById[threadId];
      const sidebarThread = environmentState.sidebarThreadSummaryById[threadId];
      const session =
        environmentState.threadSessionById[threadId] ?? sidebarThread?.session ?? null;
      const latestTurn =
        environmentState.threadTurnStateById[threadId]?.latestTurn ??
        sidebarThread?.latestTurn ??
        null;

      if (!session && !latestTurn) {
        return [];
      }

      return [
        {
          key: `${environmentId}:${threadId}`,
          threadTitle: (thread?.title ?? sidebarThread?.title ?? "Chat").trim() || "Chat",
          sessionStatus: session?.status ?? null,
          sessionUpdatedAt: session?.updatedAt ?? null,
          activeTurnId: session?.activeTurnId ? String(session.activeTurnId) : null,
          latestTurnId: latestTurn?.turnId ? String(latestTurn.turnId) : null,
          latestTurnState: latestTurn?.state ?? null,
          latestTurnCompletedAt: latestTurn?.completedAt ?? null,
        },
      ];
    });
  });
}

function snapshotMap(snapshots: readonly AgentTurnSnapshot[]): Map<string, AgentTurnSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
}

function isFreshSettlement(snapshot: AgentTurnSnapshot, mountedAtMs: number): boolean {
  const settledAt = snapshot.sessionUpdatedAt ?? snapshot.latestTurnCompletedAt;
  if (!settledAt) {
    return false;
  }

  const settledAtMs = Date.parse(settledAt);
  return !Number.isNaN(settledAtMs) && settledAtMs >= mountedAtMs - NOTIFICATION_FRESHNESS_GRACE_MS;
}

function deriveAgentTurnNotifications(input: {
  previous: ReadonlyMap<string, AgentTurnSnapshot>;
  current: ReadonlyMap<string, AgentTurnSnapshot>;
  notifiedKeys: ReadonlySet<string>;
  mountedAtMs: number;
}): AgentTurnNotificationCandidate[] {
  const notifications: AgentTurnNotificationCandidate[] = [];

  for (const [threadKey, current] of input.current) {
    const previous = input.previous.get(threadKey);
    const previousTurnId = previous?.activeTurnId ?? null;
    if (previous?.sessionStatus !== "running" || !previousTurnId) {
      continue;
    }
    if (!isFreshSettlement(current, input.mountedAtMs)) {
      continue;
    }

    const failed =
      current.sessionStatus === "error" ||
      (current.latestTurnId === previousTurnId && current.latestTurnState === "error");
    const completed =
      current.activeTurnId !== previousTurnId &&
      (current.sessionStatus === "ready" ||
        (current.latestTurnId === previousTurnId && current.latestTurnState === "completed"));
    const status: AgentTurnNotificationStatus | null = failed
      ? "failed"
      : completed
        ? "completed"
        : null;
    if (!status) {
      continue;
    }

    const dedupeKey = `${threadKey}:${previousTurnId}:${status}`;
    if (input.notifiedKeys.has(dedupeKey)) {
      continue;
    }

    notifications.push({
      dedupeKey,
      status,
      threadTitle: current.threadTitle,
    });
  }

  return notifications;
}

export function DesktopAgentNotificationsCoordinator() {
  const notificationsEnabled = useSettings(
    (settings) => settings.agentCompletionNotificationsEnabled,
  );
  const environmentStateById = useStore((state) => state.environmentStateById);
  const snapshots = useMemo(
    () => selectAgentTurnSnapshots(environmentStateById),
    [environmentStateById],
  );
  const currentByKey = useMemo(() => snapshotMap(snapshots), [snapshots]);
  const previousByKeyRef = useRef<Map<string, AgentTurnSnapshot> | null>(null);
  const notifiedKeysRef = useRef(new Set<string>());
  const mountedAtMsRef = useRef(Date.now());

  useEffect(() => {
    const previousByKey = previousByKeyRef.current;
    previousByKeyRef.current = currentByKey;
    if (!previousByKey || !notificationsEnabled) {
      return;
    }

    const notifications = deriveAgentTurnNotifications({
      previous: previousByKey,
      current: currentByKey,
      notifiedKeys: notifiedKeysRef.current,
      mountedAtMs: mountedAtMsRef.current,
    });

    for (const notification of notifications) {
      notifiedKeysRef.current.add(notification.dedupeKey);
      void showAgentTurnSystemNotification({
        status: notification.status,
        threadTitle: notification.threadTitle,
      }).catch((error) => {
        console.error(`${AGENT_NOTIFICATIONS_SCOPE} show failed`, error);
      });
    }
  }, [currentByKey, notificationsEnabled]);

  return null;
}
