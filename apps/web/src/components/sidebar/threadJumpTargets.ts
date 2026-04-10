import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreadsForSidebar } from "../Sidebar.logic";
import type { Thread } from "../../types";

type ThreadJumpTarget = Pick<Thread, "id" | "createdAt" | "updatedAt" | "messages">;

export function selectThreadJumpThreadIds<T extends ThreadJumpTarget>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
  maxCount: number,
): T["id"][] {
  const selectedThreadIds = new Set(
    sortThreadsForSidebar(threads, sortOrder)
      .slice(0, maxCount)
      .map((thread) => thread.id),
  );

  return threads.filter((thread) => selectedThreadIds.has(thread.id)).map((thread) => thread.id);
}
