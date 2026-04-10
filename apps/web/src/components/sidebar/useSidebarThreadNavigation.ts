import { useCallback } from "react";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";
import type { Thread } from "../../types";

type SidebarThreadNavigationThread = Pick<
  Thread,
  "id" | "projectId" | "archivedAt" | "createdAt" | "updatedAt" | "messages"
>;

export function useSidebarThreadNavigation(input: {
  clearSelection: () => void;
  selectedThreadIdsSize: number;
  setSelectionAnchor: (threadId: ThreadId) => void;
  threadSortOrder: SidebarThreadSortOrder;
  threads: readonly SidebarThreadNavigationThread[];
}) {
  const { clearSelection, selectedThreadIdsSize, setSelectionAnchor, threadSortOrder, threads } =
    input;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { handleNewThread: baseHandleNewThread } = useHandleNewThread();

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIdsSize > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      }).then(() => closeMobileSidebar());
    },
    [clearSelection, closeMobileSidebar, navigate, selectedThreadIdsSize, setSelectionAnchor],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
        threadSortOrder,
      )[0];
      if (!latestThread) return;
      navigateToThread(latestThread.id);
    },
    [navigateToThread, threadSortOrder, threads],
  );

  const handleNewThread = useCallback(
    async (
      projectId: ProjectId,
      options?: Parameters<typeof baseHandleNewThread>[1],
    ): Promise<void> => {
      await baseHandleNewThread(projectId, options);
      closeMobileSidebar();
    },
    [baseHandleNewThread, closeMobileSidebar],
  );

  return {
    focusMostRecentThreadForProject,
    handleNewThread,
    navigateToThread,
  };
}
