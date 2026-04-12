import type { DesktopAgentSleepState } from "@t3tools/contracts";

type PowerSaveBlockerLike = {
  readonly isStarted: (id: number) => boolean;
  readonly start: (type: "prevent-app-suspension" | "prevent-display-sleep") => number;
  readonly stop: (id: number) => boolean;
};

export function createAgentSleepBlockerController(input: {
  readonly powerSaveBlocker: PowerSaveBlockerLike;
  readonly preventSleepWhileAgentIsRunning: boolean;
  readonly log?: (message: string) => void;
}) {
  let preventSleepWhileAgentIsRunning = input.preventSleepWhileAgentIsRunning;
  let agentIsRunning = false;
  let sleepBlockerId: number | null = null;

  const isSleepBlockerActive = () =>
    sleepBlockerId !== null && input.powerSaveBlocker.isStarted(sleepBlockerId);

  const getState = (): DesktopAgentSleepState => ({
    preventSleepWhileAgentIsRunning,
    agentIsRunning,
    sleepBlockerActive: isSleepBlockerActive(),
  });

  const stopSleepBlocker = () => {
    if (sleepBlockerId === null) {
      return;
    }
    const blockerId = sleepBlockerId;
    sleepBlockerId = null;
    if (input.powerSaveBlocker.isStarted(blockerId)) {
      input.powerSaveBlocker.stop(blockerId);
      input.log?.("desktop agent sleep blocker stopped");
    }
  };

  const reconcile = () => {
    if (!preventSleepWhileAgentIsRunning || !agentIsRunning) {
      stopSleepBlocker();
      return;
    }

    if (isSleepBlockerActive()) {
      return;
    }

    stopSleepBlocker();
    sleepBlockerId = input.powerSaveBlocker.start("prevent-app-suspension");
    input.log?.("desktop agent sleep blocker started");
  };

  return {
    getState,
    setPreventSleepWhileAgentIsRunning(enabled: boolean): DesktopAgentSleepState {
      if (preventSleepWhileAgentIsRunning === enabled) {
        return getState();
      }
      preventSleepWhileAgentIsRunning = enabled;
      reconcile();
      return getState();
    },
    setAgentRunningState(nextAgentIsRunning: boolean): DesktopAgentSleepState {
      if (agentIsRunning === nextAgentIsRunning) {
        return getState();
      }
      agentIsRunning = nextAgentIsRunning;
      reconcile();
      return getState();
    },
    dispose(): void {
      stopSleepBlocker();
    },
  };
}
