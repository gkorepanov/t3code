import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { CodexThreadSync } from "../Services/CodexThreadSync.ts";
import { CodexThreadSyncLive } from "./CodexThreadSync.ts";
import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CodexAdapter, type CodexAdapterShape } from "../../provider/Services/CodexAdapter.ts";
import type { ProviderThreadSnapshot } from "../../provider/Services/ProviderAdapter.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";

class FakeCodexAdapter implements CodexAdapterShape {
  readonly provider = "codex" as const;
  readonly capabilities = { sessionModelSwitch: "in-session" as const };
  readonly streamEvents = Stream.empty as Stream.Stream<ProviderRuntimeEvent>;
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly providerThreadIdByThreadId = new Map<string, string>();

  constructor(private readonly snapshotsByProviderThreadId: Map<string, ProviderThreadSnapshot>) {}

  readonly startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.sync(() => {
      const providerThreadId =
        input.resumeCursor &&
        typeof input.resumeCursor === "object" &&
        !Array.isArray(input.resumeCursor) &&
        "threadId" in input.resumeCursor &&
        typeof input.resumeCursor.threadId === "string"
          ? input.resumeCursor.threadId
          : input.threadId;
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        resumeCursor: { threadId: providerThreadId },
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(input.threadId, session);
      this.providerThreadIdByThreadId.set(input.threadId, providerThreadId);
      return session;
    });

  readonly sendTurn = () => Effect.die(new Error("sendTurn not used in test"));
  readonly interruptTurn = () => Effect.void;
  readonly respondToRequest = () => Effect.void;
  readonly respondToUserInput = () => Effect.void;

  readonly stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      this.sessions.delete(threadId);
    });

  readonly listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.succeed(Array.from(this.sessions.values()));

  readonly hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(this.sessions.has(threadId));

  readonly readThread: CodexAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const providerThreadId = this.providerThreadIdByThreadId.get(threadId);
      const snapshot = providerThreadId
        ? this.snapshotsByProviderThreadId.get(providerThreadId)
        : undefined;
      if (!snapshot) {
        throw new Error(`No snapshot for '${threadId}'.`);
      }
      return snapshot;
    });

  readonly rollbackThread = () => Effect.die(new Error("rollbackThread not used in test"));
  readonly stopAll = () => Effect.void;
}

function makeFakeProviderService(adapter: FakeCodexAdapter) {
  return Layer.effect(
    ProviderService,
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return {
        startSession: (threadId, input) =>
          adapter.startSession(input).pipe(
            Effect.tap((session) =>
              repository.upsert({
                threadId,
                providerName: "codex",
                adapterKey: "codex",
                runtimeMode: session.runtimeMode,
                status: "running",
                lastSeenAt: session.updatedAt,
                resumeCursor: session.resumeCursor ?? null,
                runtimePayload: {
                  cwd: session.cwd ?? null,
                },
              }),
            ),
          ),
        sendTurn: () => Effect.die(new Error("sendTurn not used in test")),
        interruptTurn: () => Effect.void,
        respondToRequest: () => Effect.void,
        respondToUserInput: () => Effect.void,
        stopSession: ({ threadId }) =>
          Effect.gen(function* () {
            yield* adapter.stopSession(threadId);
            const existing = yield* repository.getByThreadId({ threadId });
            const runtime = Option.getOrUndefined(existing);
            if (!runtime) {
              return;
            }
            yield* repository.upsert({
              ...runtime,
              status: "stopped",
              lastSeenAt: new Date().toISOString(),
            });
          }),
        listSessions: () => adapter.listSessions(),
        getCapabilities: () => Effect.succeed(adapter.capabilities),
        rollbackConversation: () => Effect.void,
        streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
      } satisfies ProviderServiceShape;
    }),
  );
}

describe("CodexThreadSyncLive", () => {
  it("imports missing Codex threads, skips archived/existing ones, and persists transcript state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-sync-live-"));
    const codexHome = path.join(tempDir, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "session_index.jsonl"),
      JSON.stringify({ id: "codex-new", thread_name: "Imported from index" }),
      "utf8",
    );

    const codexDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
    codexDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'cli',
        model_provider TEXT NOT NULL DEFAULT 'openai',
        cwd TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        sandbox_policy TEXT NOT NULL DEFAULT '',
        approval_mode TEXT NOT NULL DEFAULT '',
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled'
      );
    `);
    codexDb.exec(`
      INSERT INTO threads (id, created_at, updated_at, cwd, title, first_user_message, archived)
      VALUES
        ('codex-existing', 1773230000, 1773230001, '/workspace/existing', 'Existing', 'Existing', 0),
        ('codex-new', 1773230002, 1773230005, '/workspace/imported', '', 'First imported user message', 0),
        ('codex-archived', 1773230003, 1773230004, '/workspace/archived', 'Archived', 'Archived', 1);
    `);
    codexDb.close();

    const dbPath = path.join(tempDir, "state.sqlite");
    const pathLayer = NodePath.layer;
    const baseLayer = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), tempDir).pipe(Layer.provide(pathLayer)),
      pathLayer,
      NodeServices.layer,
    );
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(baseLayer));
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(persistenceLayer),
    );
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const providerRuntimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );

    const adapter = new FakeCodexAdapter(
      new Map([
        [
          "codex-new",
          {
            threadId: ThreadId.makeUnsafe("thread-import"),
            turns: [
              {
                id: TurnId.makeUnsafe("turn-1"),
                items: [
                  { type: "userMessage", content: [{ type: "text", text: "hello" }] },
                  { type: "assistantMessage", content: [{ type: "text", text: "world" }] },
                ],
              },
            ],
          },
        ],
      ]),
    );

    const runtimeServicesLayer = Layer.mergeAll(
      orchestrationLayer,
      projectionSnapshotQueryLayer,
      providerRuntimeRepositoryLayer,
      Layer.succeed(CodexAdapter, adapter),
      makeFakeProviderService(adapter).pipe(Layer.provide(providerRuntimeRepositoryLayer)),
    );
    const hydratedRuntimeServicesLayer = runtimeServicesLayer.pipe(Layer.provide(baseLayer));
    const runtimeLayer = Layer.mergeAll(
      baseLayer,
      hydratedRuntimeServicesLayer,
      CodexThreadSyncLive.pipe(Layer.provide(hydratedRuntimeServicesLayer)),
    ) as Layer.Layer<
      | OrchestrationEngineService
      | ProjectionSnapshotQuery
      | ProviderSessionRuntimeRepository
      | ProviderService
      | CodexAdapter
      | CodexThreadSync,
      never,
      never
    >;
    const runtime = ManagedRuntime.make(runtimeLayer);

    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(Effect.service(ProviderSessionRuntimeRepository));
      const sync = await runtime.runPromise(Effect.service(CodexThreadSync));
      const projectionSnapshotQuery = await runtime.runPromise(
        Effect.service(ProjectionSnapshotQuery),
      );

      const existingProjectId = ProjectId.makeUnsafe("project-existing");
      const existingThreadId = ThreadId.makeUnsafe("thread-existing");
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-existing"),
          projectId: existingProjectId,
          title: "Existing Project",
          workspaceRoot: "/workspace/existing",
          defaultModel: "gpt-5.4",
          createdAt: "2026-03-10T18:06:40.000Z",
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-existing"),
          threadId: existingThreadId,
          projectId: existingProjectId,
          title: "Existing Thread",
          model: "gpt-5.4",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-03-10T18:06:40.000Z",
        }),
      );
      await runtime.runPromise(
        repository.upsert({
          threadId: existingThreadId,
          providerName: "codex",
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: "2026-03-10T18:06:41.000Z",
          resumeCursor: { threadId: "codex-existing" },
          runtimePayload: null,
        }),
      );

      const result = await runtime.runPromise(
        sync.syncThreads({
          codexHomePath: codexHome,
        }),
      );

      expect(result).toEqual({
        scanned: 3,
        imported: 1,
        skippedExisting: 1,
        skippedArchived: 1,
        createdProjects: 1,
        failed: [],
      });

      const snapshot = await runtime.runPromise(projectionSnapshotQuery.getSnapshot());
      const importedProject = snapshot.projects.find(
        (project) => project.workspaceRoot === "/workspace/imported",
      );
      const importedThread = snapshot.threads.find(
        (thread) => thread.projectId === importedProject?.id,
      );

      expect(importedProject?.title).toBe("imported");
      expect(importedThread?.title).toBe("Imported from index");
      expect(
        importedThread?.messages.map((message) => ({
          role: message.role,
          text: message.text,
        })),
      ).toEqual([
        { role: "user", text: "hello" },
        { role: "assistant", text: "world" },
      ]);
      expect(importedThread?.session?.status).toBe("ready");

      if (!importedThread) {
        throw new Error("Imported thread not found");
      }

      const importedRuntime = await runtime.runPromise(
        repository.getByThreadId({ threadId: importedThread.id }),
      );
      expect(Option.isSome(importedRuntime)).toBe(true);
      if (Option.isSome(importedRuntime)) {
        expect(importedRuntime.value.status).toBe("stopped");
        expect(importedRuntime.value.resumeCursor).toEqual({ threadId: "codex-new" });
      }

      await runtime.runPromise(repository.deleteByThreadId({ threadId: importedThread.id }));

      const rerun = await runtime.runPromise(
        sync.syncThreads({
          codexHomePath: codexHome,
        }),
      );

      expect(rerun).toEqual({
        scanned: 3,
        imported: 0,
        skippedExisting: 2,
        skippedArchived: 1,
        createdProjects: 0,
        failed: [],
      });

      const rerunSnapshot = await runtime.runPromise(projectionSnapshotQuery.getSnapshot());
      expect(
        rerunSnapshot.threads.filter((thread) => thread.projectId === importedProject?.id),
      ).toHaveLength(1);

      const repairedRuntime = await runtime.runPromise(
        repository.getByThreadId({ threadId: importedThread.id }),
      );
      expect(Option.isSome(repairedRuntime)).toBe(true);
      if (Option.isSome(repairedRuntime)) {
        expect(repairedRuntime.value.status).toBe("stopped");
        expect(repairedRuntime.value.resumeCursor).toEqual({ threadId: "codex-new" });
      }
    } finally {
      await runtime.dispose();
    }
  });
});
