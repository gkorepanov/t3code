import {
  EnvironmentId,
  OrchestrationShellSnapshot as OrchestrationShellSnapshotSchema,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const SHELL_SNAPSHOT_CACHE_KEY_PREFIX = "t3code:powersync-shell-snapshot:v1:";

const CachedShellSnapshotDocument = Schema.Struct({
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshotSchema,
});

const isCachedShellSnapshotDocument = Schema.is(CachedShellSnapshotDocument);

function readStorage(): Storage | null {
  return typeof window === "undefined" || !("localStorage" in window) ? null : window.localStorage;
}

function shellSnapshotCacheKey(environmentId: EnvironmentId): string {
  return `${SHELL_SNAPSHOT_CACHE_KEY_PREFIX}${environmentId}`;
}

function compareShellSnapshots(
  left: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
  right: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): number {
  if (left.snapshotSequence !== right.snapshotSequence) {
    return left.snapshotSequence - right.snapshotSequence;
  }
  if (left.updatedAt === right.updatedAt) {
    return 0;
  }
  return left.updatedAt < right.updatedAt ? -1 : 1;
}

export function readCachedPowerSyncShellSnapshot(
  environmentId: EnvironmentId,
): OrchestrationShellSnapshot | null {
  const storage = readStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(shellSnapshotCacheKey(environmentId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isCachedShellSnapshotDocument(parsed) || parsed.environmentId !== environmentId) {
      return null;
    }
    return parsed.snapshot;
  } catch {
    return null;
  }
}

export function writeCachedPowerSyncShellSnapshot(
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
): void {
  const storage = readStorage();
  if (!storage) {
    return;
  }

  const current = readCachedPowerSyncShellSnapshot(environmentId);
  if (current && compareShellSnapshots(current, snapshot) > 0) {
    return;
  }

  try {
    storage.setItem(
      shellSnapshotCacheKey(environmentId),
      JSON.stringify({ environmentId, snapshot }),
    );
  } catch {
    // PowerSync remains authoritative; this cache only removes first-paint blank states.
  }
}
