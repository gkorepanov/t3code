import os from "node:os";
import path from "node:path";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type ServerSyncCodexThreadsFailure,
  type OrchestrationSession,
  type ServerSyncCodexThreadsResult,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { CodexThreadSync, type CodexThreadSyncShape } from "../Services/CodexThreadSync.ts";
import {
  extractImportedThreadMessages,
  listCodexThreads,
  readResumeCursorThreadId,
  readSyncedCodexThreadId,
  readSessionIndexTitles,
  resolveImportedThreadTitle,
} from "../codexSync.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CodexAdapter } from "../../provider/Services/CodexAdapter.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import type { ProviderSessionRuntime } from "../../persistence/Services/ProviderSessionRuntime.ts";

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return "Sync failed.";
}

function makeCommandId(tag: string, suffix: string): CommandId {
  return CommandId.makeUnsafe(`codex-sync:${tag}:${suffix}:${crypto.randomUUID()}`);
}

function makeProjectId(cwd: string): ProjectId {
  return ProjectId.makeUnsafe(`project:codex-sync:${cwd}:${crypto.randomUUID()}`);
}

function makeThreadId(codexThreadId: string): ThreadId {
  return ThreadId.makeUnsafe(`thread:codex-sync:${codexThreadId}:${crypto.randomUUID()}`);
}

function projectTitleFromCwd(cwd: string): string {
  const baseName = path.basename(cwd);
  return baseName.length > 0 ? baseName : cwd;
}

function readySession(threadId: ThreadId, updatedAt: string): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt,
  };
}

function stoppedRuntimeBinding(
  runtime: ProviderSessionRuntime,
  stoppedAt: string,
): ProviderSessionRuntime {
  const runtimePayload =
    runtime.runtimePayload &&
    typeof runtime.runtimePayload === "object" &&
    !Array.isArray(runtime.runtimePayload)
      ? {
          ...runtime.runtimePayload,
          activeTurnId: null,
          lastError: null,
          lastRuntimeEvent: "codexSync.importStop",
          lastRuntimeEventAt: stoppedAt,
        }
      : runtime.runtimePayload;

  return {
    ...runtime,
    status: "stopped",
    lastSeenAt: stoppedAt,
    runtimePayload,
  };
}

export const CodexThreadSyncLive = Layer.effect(
  CodexThreadSync,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const providerService = yield* ProviderService;
    const codexAdapter = yield* CodexAdapter;
    const providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;

    const resumeIntoStoppedBinding = (input: {
      readonly threadId: ThreadId;
      readonly codexThreadId: string;
      readonly cwd: string;
      readonly codexBinaryPath: string | undefined;
      readonly codexHomeOverride: string | undefined;
      readonly readSnapshot: boolean;
    }) =>
      Effect.gen(function* () {
        const startedSession = yield* providerService.startSession(input.threadId, {
          threadId: input.threadId,
          provider: "codex",
          cwd: input.cwd,
          runtimeMode: "full-access",
          resumeCursor: { threadId: input.codexThreadId },
          ...(input.codexBinaryPath || input.codexHomeOverride
            ? {
                providerOptions: {
                  codex: {
                    ...(input.codexBinaryPath ? { binaryPath: input.codexBinaryPath } : {}),
                    ...(input.codexHomeOverride ? { homePath: input.codexHomeOverride } : {}),
                  },
                },
              }
            : {}),
        });
        const snapshot = input.readSnapshot
          ? yield* codexAdapter.readThread(input.threadId)
          : undefined;
        const stoppedAt = new Date().toISOString();
        yield* codexAdapter.stopSession(input.threadId);
        const persistedRuntime = yield* providerSessionRuntimeRepository.getByThreadId({
          threadId: input.threadId,
        });
        const runtime = Option.getOrUndefined(persistedRuntime);
        if (!runtime) {
          throw new Error("Missing provider runtime binding for imported Codex thread.");
        }
        const stoppedRuntime = stoppedRuntimeBinding(runtime, stoppedAt);
        yield* providerSessionRuntimeRepository.upsert(stoppedRuntime);
        return {
          startedSession,
          snapshot,
          runtime: stoppedRuntime,
        } as const;
      });

    const syncThreads: CodexThreadSyncShape["syncThreads"] = (rawInput) =>
      Effect.gen(function* () {
        const input = rawInput;
        const codexHomePath =
          normalizeOptionalPath(input.codexHomePath) ?? path.join(os.homedir(), ".codex");
        const codexBinaryPath = normalizeOptionalPath(input.codexBinaryPath);
        const codexHomeOverride = normalizeOptionalPath(input.codexHomePath);
        const stateDbPath = path.join(codexHomePath, "state_5.sqlite");
        const indexTitles = readSessionIndexTitles(codexHomePath);
        const discoveredThreads = listCodexThreads(stateDbPath);
        const readModel = yield* orchestrationEngine.getReadModel();
        const activeThreadIds = new Set(
          readModel.threads
            .filter((thread) => thread.deletedAt === null)
            .map((thread) => thread.id),
        );
        const existingProviderRuntimeRows = yield* providerSessionRuntimeRepository.list();
        const existingRuntimeByThreadId = new Map(
          existingProviderRuntimeRows.map((row) => [row.threadId, row] as const),
        );
        const importedCodexThreadIds = new Set(
          existingProviderRuntimeRows.flatMap((row) => {
            if (!activeThreadIds.has(row.threadId)) {
              return [];
            }
            const providerThreadId = readResumeCursorThreadId(row.resumeCursor);
            return providerThreadId ? [providerThreadId] : [];
          }),
        );
        const linkedThreadIdsByCodexThreadId = new Map<string, ThreadId[]>();
        readModel.threads
          .filter((thread) => thread.deletedAt === null)
          .forEach((thread) => {
            const codexThreadId = readSyncedCodexThreadId(thread.id);
            if (!codexThreadId) {
              return;
            }
            const threadIds = linkedThreadIdsByCodexThreadId.get(codexThreadId) ?? [];
            threadIds.push(thread.id);
            linkedThreadIdsByCodexThreadId.set(codexThreadId, threadIds);
          });
        existingProviderRuntimeRows.forEach((row) => {
          if (!activeThreadIds.has(row.threadId)) {
            return;
          }
          const codexThreadId = readResumeCursorThreadId(row.resumeCursor);
          if (!codexThreadId) {
            return;
          }
          const threadIds = linkedThreadIdsByCodexThreadId.get(codexThreadId) ?? [];
          if (!threadIds.includes(row.threadId)) {
            threadIds.push(row.threadId);
            linkedThreadIdsByCodexThreadId.set(codexThreadId, threadIds);
          }
        });
        const projectIdByWorkspaceRoot = new Map<string, ProjectId>(
          readModel.projects
            .filter((project) => project.deletedAt === null)
            .map((project) => [project.workspaceRoot, project.id]),
        );
        const createdProjectIds = new Set<string>();
        const failed: ServerSyncCodexThreadsFailure[] = [];
        let imported = 0;
        let skippedExisting = 0;
        let skippedArchived = 0;
        let createdProjects = 0;

        for (const candidate of discoveredThreads) {
          if (candidate.archived) {
            skippedArchived += 1;
            continue;
          }
          const resolvedTitle = resolveImportedThreadTitle({
            title: candidate.title,
            indexTitle: indexTitles.get(candidate.codexThreadId),
            firstUserMessage: candidate.firstUserMessage,
          });
          const existingSyncedThreadIds =
            linkedThreadIdsByCodexThreadId.get(candidate.codexThreadId) ?? [];
          if (existingSyncedThreadIds.length > 0) {
            for (const existingThreadId of existingSyncedThreadIds) {
              const existingThread = readModel.threads.find(
                (thread) => thread.id === existingThreadId,
              );
              if (existingThread && existingThread.title !== resolvedTitle) {
                yield* orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId: makeCommandId("title", candidate.codexThreadId),
                  threadId: existingThreadId,
                  title: resolvedTitle,
                });
              }
              if (existingRuntimeByThreadId.has(existingThreadId)) {
                continue;
              }
              const repairExit = yield* Effect.exit(
                Effect.gen(function* () {
                  const repaired = yield* resumeIntoStoppedBinding({
                    threadId: existingThreadId,
                    codexThreadId: candidate.codexThreadId,
                    cwd: candidate.cwd,
                    codexBinaryPath,
                    codexHomeOverride,
                    readSnapshot: false,
                  });
                  yield* orchestrationEngine.dispatch({
                    type: "thread.session.set",
                    commandId: makeCommandId("session-repair", candidate.codexThreadId),
                    threadId: existingThreadId,
                    session: readySession(existingThreadId, repaired.startedSession.updatedAt),
                    createdAt: repaired.startedSession.updatedAt,
                  });
                  existingRuntimeByThreadId.set(existingThreadId, repaired.runtime);
                }),
              );
              if (Exit.isFailure(repairExit)) {
                failed.push({
                  codexThreadId: candidate.codexThreadId,
                  message: readErrorMessage(Cause.squash(repairExit.cause)),
                });
              }
            }
            importedCodexThreadIds.add(candidate.codexThreadId);
            skippedExisting += 1;
            continue;
          }
          if (importedCodexThreadIds.has(candidate.codexThreadId)) {
            skippedExisting += 1;
            continue;
          }

          const threadId = makeThreadId(candidate.codexThreadId);
          let projectId = projectIdByWorkspaceRoot.get(candidate.cwd);
          let projectCreated = false;
          let threadCreated = false;

          const importExit = yield* Effect.exit(
            Effect.gen(function* () {
              const { startedSession, snapshot, runtime } = yield* resumeIntoStoppedBinding({
                threadId,
                codexThreadId: candidate.codexThreadId,
                cwd: candidate.cwd,
                codexBinaryPath,
                codexHomeOverride,
                readSnapshot: true,
              });
              existingRuntimeByThreadId.set(threadId, runtime);

              if (!projectId) {
                projectId = makeProjectId(candidate.cwd);
                yield* orchestrationEngine.dispatch({
                  type: "project.create",
                  commandId: makeCommandId("project", candidate.codexThreadId),
                  projectId,
                  title: projectTitleFromCwd(candidate.cwd),
                  workspaceRoot: candidate.cwd,
                  defaultModelSelection: {
                    provider: "codex",
                    model: DEFAULT_MODEL_BY_PROVIDER.codex,
                  },
                  createdAt: candidate.createdAt,
                });
                projectIdByWorkspaceRoot.set(candidate.cwd, projectId);
                projectCreated = true;
              }

              const currentReadModel = yield* orchestrationEngine.getReadModel();
              const project = currentReadModel.projects.find((entry) => entry.id === projectId);
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: makeCommandId("thread", candidate.codexThreadId),
                threadId,
                projectId,
                title: resolvedTitle,
                modelSelection:
                  project?.defaultModelSelection?.provider === "codex"
                    ? project.defaultModelSelection
                    : {
                        provider: "codex",
                        model: DEFAULT_MODEL_BY_PROVIDER.codex,
                      },
                runtimeMode: "full-access",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                branch: null,
                worktreePath: null,
                createdAt: candidate.createdAt,
              });
              threadCreated = true;
              if (!snapshot) {
                throw new Error("Missing thread snapshot for imported Codex thread.");
              }

              const importedMessages = extractImportedThreadMessages({
                providerThreadId: candidate.codexThreadId,
                snapshot,
                threadCreatedAt: candidate.createdAt,
                threadUpdatedAt: candidate.updatedAt,
              });
              if (importedMessages.length > 0) {
                yield* orchestrationEngine.dispatch({
                  type: "thread.history.import",
                  commandId: makeCommandId("history", candidate.codexThreadId),
                  threadId,
                  messages: importedMessages,
                  createdAt: candidate.updatedAt,
                });
              }
              yield* orchestrationEngine.dispatch({
                type: "thread.session.set",
                commandId: makeCommandId("session", candidate.codexThreadId),
                threadId,
                session: readySession(threadId, startedSession.updatedAt),
                createdAt: startedSession.updatedAt,
              });

              importedCodexThreadIds.add(candidate.codexThreadId);
              imported += 1;
              if (projectCreated && !createdProjectIds.has(projectId)) {
                createdProjectIds.add(projectId);
                createdProjects += 1;
              }
            }),
          );

          if (Exit.isSuccess(importExit)) {
            continue;
          }

          {
            const cause = Cause.squash(importExit.cause);
            failed.push({
              codexThreadId: candidate.codexThreadId,
              message: readErrorMessage(cause),
            });
            if (threadCreated) {
              yield* orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: makeCommandId("thread-delete", candidate.codexThreadId),
                  threadId,
                })
                .pipe(Effect.orElseSucceed(() => ({ sequence: -1 })));
            }
            if (projectCreated && projectId) {
              projectIdByWorkspaceRoot.delete(candidate.cwd);
              yield* orchestrationEngine
                .dispatch({
                  type: "project.delete",
                  commandId: makeCommandId("project-delete", candidate.codexThreadId),
                  projectId,
                })
                .pipe(Effect.orElseSucceed(() => ({ sequence: -1 })));
            }
            yield* providerService
              .stopSession({ threadId })
              .pipe(Effect.orElseSucceed(() => undefined));
            yield* providerSessionRuntimeRepository
              .deleteByThreadId({ threadId })
              .pipe(Effect.orElseSucceed(() => undefined));
          }
        }

        return {
          scanned: discoveredThreads.length,
          imported,
          skippedExisting,
          skippedArchived,
          createdProjects,
          failed,
        } satisfies ServerSyncCodexThreadsResult;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(readErrorMessage(cause)),
        ),
      );

    return {
      syncThreads,
    } satisfies CodexThreadSyncShape;
  }),
);
