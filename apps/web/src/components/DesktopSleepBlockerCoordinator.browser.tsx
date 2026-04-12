import "../index.css";

import { EnvironmentId, ThreadId, TurnId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DesktopSleepBlockerCoordinator } from "./DesktopSleepBlockerCoordinator";
import { type EnvironmentState, useStore } from "../store";

const baseStoreState = useStore.getState();

function makeEnvironmentState(isRunning: boolean): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: isRunning
      ? {
          [ThreadId.make("thread-running")]: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: TurnId.make("turn-running"),
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        }
      : {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

beforeEach(() => {
  useStore.setState(baseStoreState);
});

afterEach(() => {
  useStore.setState(baseStoreState);
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopBridge");
});

it("syncs the running-agent state to the desktop bridge", async () => {
  const setAgentRunningState = vi.fn<DesktopBridge["setAgentRunningState"]>().mockResolvedValue({
    preventSleepWhileAgentIsRunning: true,
    agentIsRunning: false,
    sleepBlockerActive: false,
  });
  window.desktopBridge = {
    setAgentRunningState,
  } as unknown as DesktopBridge;

  const mounted = await render(<DesktopSleepBlockerCoordinator />);

  await vi.waitFor(() => {
    expect(setAgentRunningState).toHaveBeenCalledWith(false);
  });

  useStore.setState((state) => ({
    ...state,
    activeEnvironmentId: EnvironmentId.make("environment-local"),
    environmentStateById: {
      [EnvironmentId.make("environment-local")]: makeEnvironmentState(true),
    },
  }));

  await vi.waitFor(() => {
    expect(setAgentRunningState).toHaveBeenLastCalledWith(true);
  });

  await mounted.unmount();
});
