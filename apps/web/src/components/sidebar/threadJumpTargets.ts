import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreads } from "../../lib/threadSort";
import type { Thread } from "../../types";

type ThreadJumpTarget<TId extends string = string> = {
  id: TId;
  createdAt: Thread["createdAt"];
  updatedAt?: Thread["updatedAt"];
  latestUserMessageAt?: string | null;
  messages?: Thread["messages"];
};

export function selectThreadJumpThreadIds<T extends ThreadJumpTarget>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
  maxCount: number,
): T["id"][] {
  const selectedThreadIds = new Set(
    sortThreads(threads, sortOrder)
      .slice(0, maxCount)
      .map((thread) => thread.id),
  );

  return threads.filter((thread) => selectedThreadIds.has(thread.id)).map((thread) => thread.id);
}
