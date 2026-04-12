import { useEffect } from "react";
import { selectHasRunningAgentTurn, useStore } from "../store";

const DESKTOP_AGENT_SLEEP_SCOPE = "[DESKTOP_AGENT_SLEEP]";

export function DesktopSleepBlockerCoordinator() {
  const hasRunningAgentTurn = useStore(selectHasRunningAgentTurn);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.setAgentRunningState !== "function") {
      return;
    }

    void bridge.setAgentRunningState(hasRunningAgentTurn).catch((error) => {
      console.error(`${DESKTOP_AGENT_SLEEP_SCOPE} sync failed`, error);
    });
  }, [hasRunningAgentTurn]);

  return null;
}
