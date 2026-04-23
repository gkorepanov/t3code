import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { getThreadSortTimestamp, type ThreadSortInput } from "../../lib/threadSort";

type ThreadJumpTarget<TId extends string = string> = ThreadSortInput & {
  id: TId;
};

export function selectThreadJumpThreadIds<T extends ThreadJumpTarget>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
  maxCount: number,
): T["id"][] {
  const selectedThreadIds = new Set(
    threads
      .toSorted((left, right) => {
        const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
        const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
        const byTimestamp =
          rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
        if (byTimestamp !== 0) return byTimestamp;
        return right.id.localeCompare(left.id);
      })
      .slice(0, maxCount)
      .map((thread) => thread.id),
  );

  return threads.filter((thread) => selectedThreadIds.has(thread.id)).map((thread) => thread.id);
}
