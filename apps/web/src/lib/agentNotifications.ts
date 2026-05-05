import type { DesktopAgentTurnNotification } from "@t3tools/contracts";

function getDesktopNotificationBridge() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return bridge && typeof bridge.showAgentTurnNotification === "function" ? bridge : null;
}

function getBrowserNotificationConstructor(): typeof Notification | null {
  if (typeof window === "undefined" || typeof window.Notification !== "function") {
    return null;
  }
  return window.Notification;
}

export function hasAgentTurnSystemNotificationSupport(): boolean {
  return getDesktopNotificationBridge() !== null || getBrowserNotificationConstructor() !== null;
}

export function hasDesktopAgentTurnNotificationBridge(): boolean {
  return getDesktopNotificationBridge() !== null;
}

export async function requestBrowserAgentNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  const NotificationConstructor = getBrowserNotificationConstructor();
  if (!NotificationConstructor) {
    return "unsupported";
  }
  if (NotificationConstructor.permission !== "default") {
    return NotificationConstructor.permission;
  }
  return NotificationConstructor.requestPermission();
}

function getAgentTurnNotificationTitle(status: DesktopAgentTurnNotification["status"]): string {
  return status === "failed" ? "Agent failed" : "Agent finished";
}

function normalizeAgentTurnNotificationBody(threadTitle: string): string {
  return threadTitle.trim().slice(0, 160) || "Chat";
}

function showBrowserAgentTurnNotification(notification: DesktopAgentTurnNotification): boolean {
  const NotificationConstructor = getBrowserNotificationConstructor();
  if (!NotificationConstructor || NotificationConstructor.permission !== "granted") {
    return false;
  }

  const browserNotification = new NotificationConstructor(
    getAgentTurnNotificationTitle(notification.status),
    {
      body: normalizeAgentTurnNotificationBody(notification.threadTitle),
      silent: false,
    },
  );
  browserNotification.addEventListener("click", () => {
    window.focus();
    browserNotification.close();
  });
  return true;
}

export function showAgentTurnSystemNotification(
  notification: DesktopAgentTurnNotification,
): Promise<boolean> {
  const bridge = getDesktopNotificationBridge();
  if (bridge) {
    return bridge.showAgentTurnNotification(notification);
  }
  return Promise.resolve(showBrowserAgentTurnNotification(notification));
}
