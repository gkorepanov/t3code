import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";

import {
  readCachedPowerSyncShellSnapshot,
  writeCachedPowerSyncShellSnapshot,
} from "./shellSnapshotCache";

const ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

function snapshot(
  snapshotSequence: number,
  updatedAt = "2026-01-01T00:00:00.000Z",
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [],
    threads: [],
    updatedAt,
  };
}

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  } as Storage;
}

describe("PowerSync shell snapshot cache", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a shell snapshot", () => {
    const cached = snapshot(7);

    writeCachedPowerSyncShellSnapshot(ENVIRONMENT_ID, cached);

    expect(readCachedPowerSyncShellSnapshot(ENVIRONMENT_ID)).toEqual(cached);
  });

  it("does not overwrite a newer cached snapshot with an older one", () => {
    const newer = snapshot(7, "2026-01-01T00:00:07.000Z");

    writeCachedPowerSyncShellSnapshot(ENVIRONMENT_ID, newer);
    writeCachedPowerSyncShellSnapshot(ENVIRONMENT_ID, snapshot(6, "2026-01-01T00:00:06.000Z"));

    expect(readCachedPowerSyncShellSnapshot(ENVIRONMENT_ID)).toEqual(newer);
  });
});
