import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ThreadId, type ThreadMessageQueueItem } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadMessageQueue } from "../Services/ThreadMessageQueue.ts";
import { ThreadMessageQueueLive } from "./ThreadMessageQueue.ts";

const makeQueueItem = (overrides: Partial<ThreadMessageQueueItem> = {}): ThreadMessageQueueItem => {
  const now = new Date().toISOString();
  return {
    id: "queue-item-1",
    threadId: ThreadId.make("thread-queue"),
    commandId: CommandId.make("cmd-queue-item-1"),
    messageId: MessageId.make("message-queue-item-1"),
    text: "queued message",
    attachments: [],
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    titleSeed: "queued message",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const ThreadMessageQueueTestLayer = ThreadMessageQueueLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-queue-test-" })),
  Layer.provide(NodeServices.layer),
);

it.layer(ThreadMessageQueueTestLayer)("ThreadMessageQueueLive", (it) => {
  it.effect("stores, streams, edits, and deletes queued messages", () =>
    Effect.gen(function* () {
      const queue = yield* ThreadMessageQueue;
      const threadId = ThreadId.make("thread-queue");
      const item = makeQueueItem({ threadId });

      yield* queue.enqueue(item);

      expect(yield* queue.getById({ threadId, id: item.id })).toMatchObject({
        id: item.id,
        text: "queued message",
      });

      const queuedThreadIds = yield* queue.listThreadIdsWithItems();
      expect(queuedThreadIds).toEqual([threadId]);

      const streamHead = yield* Stream.runHead(queue.streamThread({ threadId }));
      expect(Option.isSome(streamHead)).toBe(true);
      if (Option.isSome(streamHead)) {
        expect(streamHead.value.snapshot.items).toMatchObject([
          {
            id: item.id,
            text: "queued message",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
          },
        ]);
      }

      const updated = yield* queue.update({
        threadId,
        id: item.id,
        text: "edited queued message",
        updatedAt: new Date().toISOString(),
      });
      expect(updated.text).toBe("edited queued message");

      yield* queue.delete({ threadId, id: item.id });

      const snapshot = yield* queue.snapshot(threadId);
      expect(snapshot.items).toHaveLength(0);
      expect(yield* queue.listThreadIdsWithItems()).toEqual([]);
    }),
  );
});
