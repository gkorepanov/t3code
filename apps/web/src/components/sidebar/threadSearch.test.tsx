import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../../types";
import { normalizeThreadSearchQuery, searchSidebarThreads } from "./threadSearch";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

function makeThread(
  input?: Partial<Thread> & {
    messages?: Thread["messages"];
  },
): Thread {
  return {
    id: input?.id ?? ThreadId.make("thread-1"),
    environmentId: input?.environmentId ?? environmentId,
    codexThreadId: null,
    projectId: input?.projectId ?? projectId,
    title: input?.title ?? "Implement sidebar search",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: input?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    session: null,
    messages: input?.messages ?? [],
    proposedPlans: [],
    error: null,
    createdAt: input?.createdAt ?? "2026-04-12T12:00:00.000Z",
    archivedAt: input?.archivedAt ?? null,
    updatedAt: input?.updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

function makeLogicalProjectKeyMap(thread: Thread, logicalProjectKey = "logical-project") {
  return new Map([
    [scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)), logicalProjectKey],
  ]);
}

describe("normalizeThreadSearchQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeThreadSearchQuery("  sidebar   search  ")).toBe("sidebar search");
  });
});

describe("searchSidebarThreads", () => {
  it("matches thread titles before scanning messages", () => {
    const thread = makeThread({
      title: "Implement sidebar search",
      messages: [
        {
          id: "message-1" as never,
          role: "assistant",
          text: "This text should not be used when the title already matches.",
          createdAt: "2026-04-12T12:01:00.000Z",
          streaming: false,
          completedAt: "2026-04-12T12:01:05.000Z",
        },
      ],
    });

    const result = searchSidebarThreads({
      query: "sidebar",
      threads: [thread],
      logicalProjectKeyByPhysicalProjectKey: makeLogicalProjectKeyMap(thread),
    });

    expect(result.hasActiveSearch).toBe(true);
    expect([...result.matchedProjectKeys]).toEqual(["logical-project"]);

    const match = [...result.matchesByThreadKey.values()][0];
    expect(match?.source).toBe("title");
    expect(match?.segments.some((segment) => segment.matched)).toBe(true);
    expect(match?.segments.map((segment) => segment.text).join("")).toBe(
      "Implement sidebar search",
    );
  });

  it("does not treat fuzzy subsequences as matches", () => {
    const thread = makeThread({
      title: "Implement sidebar search",
    });

    const result = searchSidebarThreads({
      query: "sbdsrch",
      threads: [thread],
      logicalProjectKeyByPhysicalProjectKey: makeLogicalProjectKeyMap(thread),
    });

    expect(result.matchesByThreadKey.size).toBe(0);
    expect(result.matchedProjectKeys.size).toBe(0);
  });

  it("matches assistant and user messages but ignores system messages", () => {
    const ignoredSystemThread = makeThread({
      id: ThreadId.make("thread-system"),
      title: "Daily notes",
      messages: [
        {
          id: "message-system" as never,
          role: "system",
          text: "needle hidden in system prompt",
          createdAt: "2026-04-12T12:01:00.000Z",
          streaming: false,
          completedAt: "2026-04-12T12:01:01.000Z",
        },
      ],
    });
    const matchedAssistantThread = makeThread({
      id: ThreadId.make("thread-assistant"),
      title: "Release prep",
      messages: [
        {
          id: "message-user" as never,
          role: "user",
          text: "Can you summarize the release plan?",
          createdAt: "2026-04-12T12:02:00.000Z",
          streaming: false,
          completedAt: "2026-04-12T12:02:01.000Z",
        },
        {
          id: "message-assistant" as never,
          role: "assistant",
          text: "Needle found inside the assistant response body.",
          createdAt: "2026-04-12T12:03:00.000Z",
          streaming: false,
          completedAt: "2026-04-12T12:03:01.000Z",
        },
      ],
    });

    const result = searchSidebarThreads({
      query: "needle",
      threads: [ignoredSystemThread, matchedAssistantThread],
      logicalProjectKeyByPhysicalProjectKey: new Map([
        ...makeLogicalProjectKeyMap(ignoredSystemThread),
        ...makeLogicalProjectKeyMap(matchedAssistantThread),
      ]),
    });

    expect(result.matchesByThreadKey.size).toBe(1);

    const match = [...result.matchesByThreadKey.values()][0];
    expect(match?.source).toBe("message");
    expect(match?.segments.map((segment) => segment.text).join("")).toContain("Needle found");
    expect(match?.segments.some((segment) => segment.matched)).toBe(true);
  });

  it("returns an inactive result for an empty query", () => {
    const result = searchSidebarThreads({
      query: "   ",
      threads: [makeThread()],
      logicalProjectKeyByPhysicalProjectKey: makeLogicalProjectKeyMap(makeThread()),
    });

    expect(result).toEqual({
      hasActiveSearch: false,
      matchedProjectKeys: new Set(),
      matchesByThreadKey: new Map(),
    });
  });
});
