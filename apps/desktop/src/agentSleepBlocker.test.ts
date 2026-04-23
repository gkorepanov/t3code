import { describe, expect, it, vi } from "vitest";
import { createAgentSleepBlockerController } from "./agentSleepBlocker.js";

function createPowerSaveBlockerStub() {
  const startedIds = new Set<number>();
  let nextId = 1;

  return {
    startedIds,
    powerSaveBlocker: {
      isStarted: vi.fn((id: number) => startedIds.has(id)),
      start: vi.fn(() => {
        const id = nextId++;
        startedIds.add(id);
        return id;
      }),
      stop: vi.fn((id: number) => startedIds.delete(id)),
    },
  };
}

describe("createAgentSleepBlockerController", () => {
  it("starts blocking sleep only while both the preference and agent state are active", () => {
    const { powerSaveBlocker } = createPowerSaveBlockerStub();
    const controller = createAgentSleepBlockerController({
      powerSaveBlocker,
      preventSleepWhileAgentIsRunning: false,
    });

    expect(controller.getState()).toEqual({
      preventSleepWhileAgentIsRunning: false,
      agentIsRunning: false,
      sleepBlockerActive: false,
    });

    controller.setAgentRunningState(true);
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();

    expect(controller.setPreventSleepWhileAgentIsRunning(true)).toEqual({
      preventSleepWhileAgentIsRunning: true,
      agentIsRunning: true,
      sleepBlockerActive: true,
    });
    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
  });

  it("stops blocking sleep when the agent stops or the preference is disabled", () => {
    const { powerSaveBlocker } = createPowerSaveBlockerStub();
    const controller = createAgentSleepBlockerController({
      powerSaveBlocker,
      preventSleepWhileAgentIsRunning: true,
    });

    controller.setAgentRunningState(true);
    expect(controller.getState().sleepBlockerActive).toBe(true);

    expect(controller.setAgentRunningState(false).sleepBlockerActive).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);

    controller.setAgentRunningState(true);
    expect(controller.getState().sleepBlockerActive).toBe(true);

    expect(controller.setPreventSleepWhileAgentIsRunning(false).sleepBlockerActive).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(2);
  });

  it("disposes an active blocker", () => {
    const { powerSaveBlocker } = createPowerSaveBlockerStub();
    const controller = createAgentSleepBlockerController({
      powerSaveBlocker,
      preventSleepWhileAgentIsRunning: true,
    });

    controller.setAgentRunningState(true);
    controller.dispose();

    expect(controller.getState().sleepBlockerActive).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });
});
