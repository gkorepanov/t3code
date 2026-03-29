import type { Thread } from "../types";

type SidebarSearchThread = Pick<Thread, "title" | "messages">;

export function normalizeSidebarSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function threadMatchesSidebarSearch<T extends SidebarSearchThread>(
  thread: T,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }
  if (thread.title.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  for (const message of thread.messages) {
    if (message.text.toLowerCase().includes(normalizedQuery)) {
      return true;
    }
  }
  return false;
}

export function filterThreadsForSidebarSearch<T extends SidebarSearchThread>(
  threads: readonly T[],
  normalizedQuery: string,
): T[] {
  if (normalizedQuery.length === 0) {
    return [...threads];
  }

  const matchedThreads: T[] = [];
  for (const thread of threads) {
    if (threadMatchesSidebarSearch(thread, normalizedQuery)) {
      matchedThreads.push(thread);
    }
  }
  return matchedThreads;
}
