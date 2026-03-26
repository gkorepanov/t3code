import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerManager,
  type CodexAppServerArchiveThreadInput,
} from "../../codexAppServerManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntime,
} from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CodexThreadArchive } from "../Services/CodexThreadArchive.ts";
import { makeCodexThreadArchiveLive } from "./CodexThreadArchive.ts";

function makeReadModel(threadId: ThreadId): OrchestrationReadModel {
  const projectId = ProjectId.makeUnsafe("project-1");
  const now = "2026-03-11T12:00:00.000Z";
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Imported thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: now,
  };
}

class FakeCodexManager extends CodexAppServerManager {
  public archiveThreadImpl = vi.fn(async (_input: CodexAppServerArchiveThreadInput) => undefined);

  override archiveThread(input: CodexAppServerArchiveThreadInput): Promise<void> {
    return this.archiveThreadImpl(input);
  }
}

function makeRuntimeRepositoryLayer(runtime?: ProviderSessionRuntime) {
  return Layer.succeed(ProviderSessionRuntimeRepository, {
    upsert: () => Effect.void,
    getByThreadId: () => Effect.succeed(runtime ? Option.some(runtime) : Option.none()),
    list: () => Effect.succeed([]),
    deleteByThreadId: () => Effect.void,
  });
}

describe("CodexThreadArchiveLive", () => {
  it("archives synced Codex threads and returns the linked Codex thread id", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread:codex-sync:codex-thread-1:local-thread");
        const stopSession = vi.fn(() => Effect.void);
        const manager = new FakeCodexManager();
        const archiveLayer = makeCodexThreadArchiveLive({
          makeManager: () => manager,
        }).pipe(
          Layer.provideMerge(
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () => Effect.succeed(makeReadModel(threadId)),
              readEvents: () => Stream.empty,
              dispatch: () => Effect.die("dispatch not used"),
              streamDomainEvents: Stream.empty,
            }),
          ),
          Layer.provideMerge(makeRuntimeRepositoryLayer()),
          Layer.provideMerge(
            Layer.succeed(ProviderService, {
              startSession: () => Effect.die("startSession not used"),
              sendTurn: () => Effect.die("sendTurn not used"),
              interruptTurn: () => Effect.void,
              respondToRequest: () => Effect.void,
              respondToUserInput: () => Effect.void,
              stopSession,
              listSessions: () => Effect.succeed([]),
              getCapabilities: () => Effect.die("getCapabilities not used"),
              rollbackConversation: () => Effect.void,
              streamEvents: Stream.empty,
            }),
          ),
        );

        const archive = yield* Effect.service(CodexThreadArchive).pipe(
          Effect.provide(archiveLayer),
        );
        const result = yield* archive.archiveThread({
          threadId,
          codexBinaryPath: "/usr/local/bin/codex",
          codexHomePath: "/tmp/.codex",
        });

        expect(result).toEqual({
          codexThreadId: "codex-thread-1",
        });
        expect(stopSession).toHaveBeenCalledWith({
          threadId,
        });
        expect(manager.archiveThreadImpl).toHaveBeenCalledTimes(1);
        expect(manager.archiveThreadImpl.mock.calls[0]?.[0]).toEqual({
          threadId: expect.stringMatching(/^thread:codex-archive:codex-thread-1:/),
          providerThreadId: "codex-thread-1",
          cwd: "/workspace/project",
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath: "/usr/local/bin/codex",
              homePath: "/tmp/.codex",
            },
          },
        });
      }),
    );
  });

  it("no-ops for threads that are not linked to Codex", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-local");
        const stopSession = vi.fn(() => Effect.void);
        const manager = new FakeCodexManager();
        const archiveLayer = makeCodexThreadArchiveLive({
          makeManager: () => manager,
        }).pipe(
          Layer.provideMerge(
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () => Effect.succeed(makeReadModel(threadId)),
              readEvents: () => Stream.empty,
              dispatch: () => Effect.die("dispatch not used"),
              streamDomainEvents: Stream.empty,
            }),
          ),
          Layer.provideMerge(makeRuntimeRepositoryLayer()),
          Layer.provideMerge(
            Layer.succeed(ProviderService, {
              startSession: () => Effect.die("startSession not used"),
              sendTurn: () => Effect.die("sendTurn not used"),
              interruptTurn: () => Effect.void,
              respondToRequest: () => Effect.void,
              respondToUserInput: () => Effect.void,
              stopSession,
              listSessions: () => Effect.succeed([]),
              getCapabilities: () => Effect.die("getCapabilities not used"),
              rollbackConversation: () => Effect.void,
              streamEvents: Stream.empty,
            }),
          ),
        );

        const archive = yield* Effect.service(CodexThreadArchive).pipe(
          Effect.provide(archiveLayer),
        );
        const result = yield* archive.archiveThread({
          threadId,
        });

        expect(result).toEqual({
          codexThreadId: null,
        });
        expect(stopSession).not.toHaveBeenCalled();
        expect(manager.archiveThreadImpl).not.toHaveBeenCalled();
      }),
    );
  });

  it("treats missing-rollout archive failures as already archived", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread:codex-sync:codex-thread-1:local-thread");
        const manager = new FakeCodexManager();
        manager.archiveThreadImpl.mockRejectedValueOnce(
          new Error("thread/resume failed: no rollout found for thread id codex-thread-1"),
        );

        const archiveLayer = makeCodexThreadArchiveLive({
          makeManager: () => manager,
        }).pipe(
          Layer.provideMerge(
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () => Effect.succeed(makeReadModel(threadId)),
              readEvents: () => Stream.empty,
              dispatch: () => Effect.die("dispatch not used"),
              streamDomainEvents: Stream.empty,
            }),
          ),
          Layer.provideMerge(makeRuntimeRepositoryLayer()),
          Layer.provideMerge(
            Layer.succeed(ProviderService, {
              startSession: () => Effect.die("startSession not used"),
              sendTurn: () => Effect.die("sendTurn not used"),
              interruptTurn: () => Effect.void,
              respondToRequest: () => Effect.void,
              respondToUserInput: () => Effect.void,
              stopSession: () => Effect.void,
              listSessions: () => Effect.succeed([]),
              getCapabilities: () => Effect.die("getCapabilities not used"),
              rollbackConversation: () => Effect.void,
              streamEvents: Stream.empty,
            }),
          ),
        );

        const archive = yield* Effect.service(CodexThreadArchive).pipe(
          Effect.provide(archiveLayer),
        );
        const result = yield* archive.archiveThread({
          threadId,
        });

        expect(result).toEqual({
          codexThreadId: "codex-thread-1",
        });
      }),
    );
  });
});
