import type { NativeApi, OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import { clearPromotedDraftThreads, useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { collectActiveTerminalThreadIds } from "./terminalStateCleanup";

interface OrchestrationSnapshotApi {
  orchestration: Pick<NativeApi["orchestration"], "getSnapshot">;
}

export function applyOrchestrationSnapshot(snapshot: OrchestrationReadModel): void {
  useStore.getState().syncServerReadModel(snapshot);
  clearPromotedDraftThreads(new Set(snapshot.threads.map((thread) => thread.id)));

  const draftThreadIds = Object.keys(
    useComposerDraftStore.getState().draftThreadsByThreadId,
  ) as ThreadId[];
  const activeThreadIds = collectActiveTerminalThreadIds({
    snapshotThreads: snapshot.threads,
    draftThreadIds,
  });

  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadIds);
}

export async function syncOrchestrationSnapshot(
  api: OrchestrationSnapshotApi,
): Promise<OrchestrationReadModel> {
  const snapshot = await api.orchestration.getSnapshot();
  applyOrchestrationSnapshot(snapshot);
  return snapshot;
}
