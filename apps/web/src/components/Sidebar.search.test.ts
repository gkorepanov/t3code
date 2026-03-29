import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { type Thread } from "../types";
import {
  filterThreadsForSidebarSearch,
  normalizeSidebarSearchQuery,
  threadMatchesSidebarSearch,
} from "./Sidebar.search";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("normalizeSidebarSearchQuery", () => {
  it("trims and lowercases the search query", () => {
    expect(normalizeSidebarSearchQuery("  Fix Login  ")).toBe("fix login");
  });
});

describe("threadMatchesSidebarSearch", () => {
  it("matches by thread title", () => {
    expect(
      threadMatchesSidebarSearch(
        makeThread({ title: "Fix auth redirect" }),
        normalizeSidebarSearchQuery("auth"),
      ),
    ).toBe(true);
  });

  it("matches by message text", () => {
    expect(
      threadMatchesSidebarSearch(
        makeThread({
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "The refund workflow is broken on checkout.",
              createdAt: "2026-03-09T10:00:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:00:00.000Z",
            },
          ],
        }),
        normalizeSidebarSearchQuery("refund workflow"),
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      threadMatchesSidebarSearch(
        makeThread({ title: "Need SQL Index" }),
        normalizeSidebarSearchQuery("sql index"),
      ),
    ).toBe(true);
  });

  it("returns false when there is no match", () => {
    expect(
      threadMatchesSidebarSearch(
        makeThread({
          title: "Payments",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "Check the webhook retries.",
              createdAt: "2026-03-09T10:00:00.000Z",
              streaming: false,
            },
          ],
        }),
        normalizeSidebarSearchQuery("latency regression"),
      ),
    ).toBe(false);
  });
});

describe("filterThreadsForSidebarSearch", () => {
  it("preserves input order after filtering", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        title: "Refund issue",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        title: "Other thread",
        messages: [
          {
            id: "message-2" as never,
            role: "assistant",
            text: "refund path is flaky",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        title: "Database thread",
      }),
    ];

    expect(
      filterThreadsForSidebarSearch(threads, normalizeSidebarSearchQuery("refund")).map(
        (thread) => thread.id,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")]);
  });
});
