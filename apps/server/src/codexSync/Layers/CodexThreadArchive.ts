import {
  ThreadId,
  type RuntimeMode,
  type ServerArchiveCodexThreadResult,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  readResumeCursorThreadId,
  readSyncedCodexThreadId,
} from "../codexSync.ts";
import { CodexThreadArchive, type CodexThreadArchiveShape } from "../Services/CodexThreadArchive.ts";

export interface CodexThreadArchiveLiveOptions {
  readonly makeManager?: () => CodexAppServerManager;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function makeArchiveSessionThreadId(codexThreadId: string): ThreadId {
  return ThreadId.makeUnsafe(`thread:codex-archive:${codexThreadId}:${crypto.randomUUID()}`);
}

function readRuntimePayloadCwd(runtimePayload: unknown): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") {
    return undefined;
  }
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(String(cause));
}

function isSatisfiedArchiveFailure(cause: unknown): boolean {
  const message = toError(cause).message.toLowerCase();
  return (
    message.includes("already archived") ||
    message.includes("thread/archived") ||
    message.includes("thread is archived") ||
    message.includes("missing thread") ||
    message.includes("no such thread") ||
    message.includes("unknown thread") ||
    message.includes("does not exist") ||
    message.includes("not found")
  );
}

export const makeCodexThreadArchiveLive = (options?: CodexThreadArchiveLiveOptions) =>
  Layer.effect(
    CodexThreadArchive,
    Effect.gen(function* () {
      const orchestrationEngine = yield* OrchestrationEngineService;
      const providerService = yield* ProviderService;
      const providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;

      const archiveThread: CodexThreadArchiveShape["archiveThread"] = (rawInput) =>
        Effect.gen(function* () {
          const input = rawInput;
          const readModel = yield* orchestrationEngine.getReadModel();
          const runtimeRow = Option.getOrUndefined(
            yield* providerSessionRuntimeRepository.getByThreadId({ threadId: input.threadId }),
          );
          const codexThreadId =
            readResumeCursorThreadId(runtimeRow?.resumeCursor) ?? readSyncedCodexThreadId(input.threadId);

          if (!codexThreadId) {
            return {
              codexThreadId: null,
            } satisfies ServerArchiveCodexThreadResult;
          }

          const thread = readModel.threads.find((entry) => entry.id === input.threadId);
          const project = thread
            ? readModel.projects.find((entry) => entry.id === thread.projectId)
            : undefined;
          const cwd = project?.workspaceRoot ?? readRuntimePayloadCwd(runtimeRow?.runtimePayload);
          if (!cwd) {
            return yield* Effect.fail(
              new Error(
                `Cannot archive Codex thread '${codexThreadId}' because no workspace root is available.`,
              ),
            );
          }

          yield* providerService.stopSession({ threadId: input.threadId }).pipe(
            Effect.orElseSucceed(() => undefined),
          );

          const manager = options?.makeManager?.() ?? new CodexAppServerManager();
          const runtimeMode: RuntimeMode = thread?.runtimeMode ?? runtimeRow?.runtimeMode ?? "full-access";
          const codexBinaryPath = normalizeOptionalPath(input.codexBinaryPath);
          const codexHomePath = normalizeOptionalPath(input.codexHomePath);
          const archiveExit = yield* Effect.exit(
            Effect.promise(() =>
              manager.archiveThread({
                threadId: makeArchiveSessionThreadId(codexThreadId),
                providerThreadId: codexThreadId,
                cwd,
                runtimeMode,
                ...(codexBinaryPath || codexHomePath
                  ? {
                      providerOptions: {
                        codex: {
                          ...(codexBinaryPath ? { binaryPath: codexBinaryPath } : {}),
                          ...(codexHomePath ? { homePath: codexHomePath } : {}),
                        },
                      },
                    }
                  : {}),
              }),
            ),
          );

          if (Exit.isFailure(archiveExit)) {
            const error = Cause.squash(archiveExit.cause);
            if (!isSatisfiedArchiveFailure(error)) {
              return yield* Effect.fail(toError(error));
            }
          }

          return {
            codexThreadId,
          } satisfies ServerArchiveCodexThreadResult;
        }).pipe(Effect.mapError(toError));

      return {
        archiveThread,
      } satisfies CodexThreadArchiveShape;
    }),
  );

export const CodexThreadArchiveLive = makeCodexThreadArchiveLive();
