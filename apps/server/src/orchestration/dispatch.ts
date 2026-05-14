import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type ClientOrchestrationCommand,
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isOrchestrationDispatchCommandError(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

export const dispatchNormalizedOrchestrationCommand = (normalizedCommand: OrchestrationCommand) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const startup = yield* ServerRuntimeStartup;
    const gitWorkflow = yield* GitWorkflowService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
    const terminalManager = yield* TerminalManager;

    const refreshGitStatus = (cwd: string) =>
      vcsStatusBroadcaster
        .refreshStatus(cwd)
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

    const appendSetupScriptActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("setup-script-activity"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });

    const dispatchBootstrapTurnStart = (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
      Effect.gen(function* () {
        const bootstrap = command.bootstrap;
        const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
        let createdThread = false;
        let targetProjectId = bootstrap?.createThread?.projectId;
        let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
        let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

        const cleanupCreatedThread = () =>
          createdThread
            ? orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: serverCommandId("bootstrap-thread-delete"),
                  threadId: command.threadId,
                })
                .pipe(Effect.ignoreCause({ log: true }))
            : Effect.void;

        const recordSetupScriptLaunchFailure = (input: {
          readonly error: unknown;
          readonly requestedAt: string;
          readonly worktreePath: string;
        }) => {
          const detail =
            input.error instanceof Error ? input.error.message : "Unknown setup failure.";
          return appendSetupScriptActivity({
            threadId: command.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: {
              detail,
              worktreePath: input.worktreePath,
            },
            tone: "error",
          }).pipe(
            Effect.ignoreCause({ log: false }),
            Effect.flatMap(() =>
              Effect.logWarning("bootstrap turn start failed to launch setup script", {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                detail,
              }),
            ),
          );
        };

        const recordSetupScriptStarted = (input: {
          readonly requestedAt: string;
          readonly worktreePath: string;
          readonly scriptId: string;
          readonly scriptName: string;
          readonly terminalId: string;
        }) =>
          Effect.gen(function* () {
            const startedAt = yield* nowIso;
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            yield* Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: startedAt,
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          });

        const runSetupProgram = () =>
          Effect.gen(function* () {
            if (!bootstrap?.runSetupScript || !targetWorktreePath) {
              return;
            }
            const worktreePath = targetWorktreePath;
            const requestedAt = yield* nowIso;
            yield* projectSetupScriptRunner
              .runForThread({
                threadId: command.threadId,
                ...(targetProjectId ? { projectId: targetProjectId } : {}),
                ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                worktreePath,
              })
              .pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    recordSetupScriptLaunchFailure({
                      error,
                      requestedAt,
                      worktreePath,
                    }),
                  onSuccess: (setupResult) => {
                    if (setupResult.status !== "started") {
                      return Effect.void;
                    }
                    return recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    });
                  },
                }),
              );
          });

        const bootstrapProgram = Effect.gen(function* () {
          if (bootstrap?.createThread) {
            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            });
            createdThread = true;
          }

          if (bootstrap?.prepareWorktree) {
            const worktree = yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              newRefName: bootstrap.prepareWorktree.branch,
              path: null,
            });
            targetWorktreePath = worktree.worktree.path;
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: worktree.worktree.refName,
              worktreePath: targetWorktreePath,
            });
            yield* refreshGitStatus(targetWorktreePath);
          }

          yield* runSetupProgram();

          return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
        });

        return yield* bootstrapProgram.pipe(
          Effect.catchCause((cause) => {
            const dispatchError = toBootstrapDispatchCommandCauseError(cause);
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.fail(dispatchError);
            }
            return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
          }),
        );
      });

    const dispatchCore = (
      command: OrchestrationCommand,
    ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
      const dispatchEffect =
        command.type === "thread.turn.start" && command.bootstrap
          ? dispatchBootstrapTurnStart(command)
          : orchestrationEngine
              .dispatch(command)
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              );

      return startup
        .enqueueCommand(dispatchEffect)
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        );
    };

    const shouldStopSessionAfterArchive =
      normalizedCommand.type === "thread.archive"
        ? yield* projectionSnapshotQuery.getThreadShellById(normalizedCommand.threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (thread) => thread.session !== null && thread.session.status !== "stopped",
              }),
            ),
            Effect.catch(() => Effect.succeed(false)),
          )
        : false;

    const result = yield* dispatchCore(normalizedCommand);

    if (normalizedCommand.type === "thread.archive") {
      if (shouldStopSessionAfterArchive) {
        yield* Effect.gen(function* () {
          const stopCommand = yield* normalizeDispatchCommand({
            type: "thread.session.stop",
            commandId: CommandId.make(`session-stop-for-archive:${normalizedCommand.commandId}`),
            threadId: normalizedCommand.threadId,
            createdAt: yield* nowIso,
          });

          yield* dispatchCore(stopCommand);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to stop provider session during archive", {
              threadId: normalizedCommand.threadId,
              cause,
            }),
          ),
        );
      }

      yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close thread terminals after archive", {
            threadId: normalizedCommand.threadId,
            error: error.message,
          }),
        ),
      );
    }

    return result;
  });

export const dispatchClientOrchestrationCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const normalizedCommand = yield* normalizeDispatchCommand(command);
    return yield* dispatchNormalizedOrchestrationCommand(normalizedCommand);
  });
