import {
  ChatAttachment,
  ModelSelection,
  OrchestrationDispatchCommandError,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  ThreadMessageQueueItem,
  TrimmedNonEmptyString,
  IsoDateTime,
  type ThreadMessageQueueSnapshot,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ThreadMessageQueue,
  type ThreadMessageQueueShape,
} from "../Services/ThreadMessageQueue.ts";

const ThreadMessageQueueDbRow = Schema.Struct({
  id: ThreadMessageQueueItem.fields.id,
  threadId: ThreadId,
  commandId: ThreadMessageQueueItem.fields.commandId,
  messageId: ThreadMessageQueueItem.fields.messageId,
  text: Schema.String,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  titleSeed: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

type ThreadMessageQueueDbRow = typeof ThreadMessageQueueDbRow.Type;

function queueError(message: string, cause?: unknown): OrchestrationDispatchCommandError {
  return new OrchestrationDispatchCommandError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function sqlError(operation: string) {
  return (cause: unknown) => queueError(`Failed to ${operation}.`, cause);
}

function rowToItem(row: ThreadMessageQueueDbRow) {
  const candidate = {
    id: row.id,
    threadId: row.threadId,
    commandId: row.commandId,
    messageId: row.messageId,
    text: row.text,
    attachments: row.attachments,
    ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
    ...(row.titleSeed !== null ? { titleSeed: row.titleSeed } : {}),
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return Schema.decodeUnknownEffect(ThreadMessageQueueItem)(candidate).pipe(
    Effect.mapError((cause) => queueError("Failed to decode queued message.", cause)),
  );
}

function decodeRow(row: unknown) {
  return Schema.decodeUnknownEffect(ThreadMessageQueueDbRow)(row).pipe(
    Effect.mapError((cause) => queueError("Failed to decode queued message row.", cause)),
    Effect.flatMap(rowToItem),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const changes = yield* PubSub.unbounded<ThreadId>();

  const publish = (threadId: ThreadId) => PubSub.publish(changes, threadId).pipe(Effect.asVoid);

  const readRows = (threadId: ThreadId) =>
    sql<ThreadMessageQueueDbRow>`
      SELECT
        queue_item_id AS "id",
        thread_id AS "threadId",
        command_id AS "commandId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        title_seed AS "titleSeed",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_message_queue
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, queue_item_id ASC
    `.pipe(
      Effect.mapError(sqlError("list queued messages")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow, { concurrency: 1 })),
    );

  const snapshot: ThreadMessageQueueShape["snapshot"] = (threadId) =>
    readRows(threadId).pipe(
      Effect.map(
        (items): ThreadMessageQueueSnapshot => ({
          threadId,
          items: [...items],
        }),
      ),
    );

  const enqueue: ThreadMessageQueueShape["enqueue"] = (item) =>
    sql`
      INSERT INTO thread_message_queue (
        queue_item_id,
        thread_id,
        command_id,
        message_id,
        text,
        attachments_json,
        model_selection_json,
        title_seed,
        runtime_mode,
        interaction_mode,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        created_at,
        updated_at
      )
      VALUES (
        ${item.id},
        ${item.threadId},
        ${item.commandId},
        ${item.messageId},
        ${item.text},
        ${JSON.stringify(item.attachments)},
        ${item.modelSelection ? JSON.stringify(item.modelSelection) : null},
        ${item.titleSeed ?? null},
        ${item.runtimeMode},
        ${item.interactionMode},
        ${item.sourceProposedPlan?.threadId ?? null},
        ${item.sourceProposedPlan?.planId ?? null},
        ${item.createdAt},
        ${item.updatedAt}
      )
    `.pipe(
      Effect.mapError(sqlError("enqueue message")),
      Effect.flatMap(() => publish(item.threadId)),
      Effect.as(item),
    );

  const update: ThreadMessageQueueShape["update"] = (input) =>
    sql
      .withTransaction(
        sql`
        UPDATE thread_message_queue
        SET text = ${input.text}, updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND queue_item_id = ${input.id}
      `.pipe(
          Effect.mapError(sqlError("update queued message")),
          Effect.flatMap(() => readRows(input.threadId)),
          Effect.flatMap((items) =>
            Effect.gen(function* () {
              const item = items.find((entry) => entry.id === input.id);
              if (!item) {
                return yield* queueError("Queued message was not found.");
              }
              yield* publish(input.threadId);
              return item;
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrchestrationDispatchCommandError)(cause)
            ? cause
            : sqlError("update queued message")(cause),
        ),
      );

  const removeAttachmentFiles = (item: ThreadMessageQueueItem) =>
    Effect.forEach(
      item.attachments,
      (attachment) => {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        return attachmentPath
          ? fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore)
          : Effect.void;
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

  const deleteItem: ThreadMessageQueueShape["delete"] = (input, options) =>
    sql
      .withTransaction(
        readRows(input.threadId).pipe(
          Effect.map((items) => items.find((entry) => entry.id === input.id) ?? null),
          Effect.flatMap((item) =>
            sql`
            DELETE FROM thread_message_queue
            WHERE thread_id = ${input.threadId}
              AND queue_item_id = ${input.id}
          `.pipe(Effect.mapError(sqlError("delete queued message")), Effect.as(item)),
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrchestrationDispatchCommandError)(cause)
            ? cause
            : sqlError("delete queued message")(cause),
        ),
        Effect.flatMap((item) =>
          item && options?.preserveAttachments !== true ? removeAttachmentFiles(item) : Effect.void,
        ),
        Effect.flatMap(() => publish(input.threadId)),
      );

  const listByThreadId: ThreadMessageQueueShape["listByThreadId"] = (input) =>
    readRows(input.threadId);

  const getFirstByThreadId: ThreadMessageQueueShape["getFirstByThreadId"] = (threadId) =>
    readRows(threadId).pipe(Effect.map((items) => items[0] ?? null));

  const getById: ThreadMessageQueueShape["getById"] = (input) =>
    readRows(input.threadId).pipe(
      Effect.map((items) => items.find((entry) => entry.id === input.id) ?? null),
    );

  const listThreadIdsWithItems: ThreadMessageQueueShape["listThreadIdsWithItems"] = () =>
    sql<{ readonly threadId: ThreadId }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM thread_message_queue
      ORDER BY thread_id ASC
    `.pipe(
      Effect.mapError(sqlError("list queued message threads")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const streamThread: ThreadMessageQueueShape["streamThread"] = (input) => {
    const snapshotItem = snapshot(input.threadId).pipe(
      Effect.map((nextSnapshot) => ({
        kind: "snapshot" as const,
        snapshot: nextSnapshot,
      })),
    );

    return Stream.concat(
      Stream.fromEffect(snapshotItem),
      Stream.fromPubSub(changes).pipe(
        Stream.filter((threadId) => threadId === input.threadId),
        Stream.mapEffect(() => snapshotItem),
      ),
    );
  };

  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  return {
    enqueue,
    update,
    delete: deleteItem,
    listByThreadId,
    getFirstByThreadId,
    getById,
    listThreadIdsWithItems,
    snapshot,
    streamThread,
  } satisfies ThreadMessageQueueShape;
});

export const ThreadMessageQueueLive = Layer.effect(ThreadMessageQueue, make);
