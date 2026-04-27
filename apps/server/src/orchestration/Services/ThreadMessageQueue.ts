import type {
  ThreadId,
  ThreadMessageQueueDeleteInput,
  ThreadMessageQueueDispatchNowInput,
  ThreadMessageQueueItem,
  ThreadMessageQueueSnapshot,
  ThreadMessageQueueStreamItem,
  ThreadMessageQueueSubscribeInput,
  ThreadMessageQueueUpdateInput,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface ThreadMessageQueueShape {
  readonly enqueue: (
    item: ThreadMessageQueueItem,
  ) => Effect.Effect<ThreadMessageQueueItem, OrchestrationDispatchCommandError>;
  readonly update: (
    input: ThreadMessageQueueUpdateInput,
  ) => Effect.Effect<ThreadMessageQueueItem, OrchestrationDispatchCommandError>;
  readonly delete: (
    input: ThreadMessageQueueDeleteInput,
    options?: { readonly preserveAttachments?: boolean },
  ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  readonly listByThreadId: (
    input: ThreadMessageQueueSubscribeInput,
  ) => Effect.Effect<ReadonlyArray<ThreadMessageQueueItem>, OrchestrationDispatchCommandError>;
  readonly getFirstByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadMessageQueueItem | null, OrchestrationDispatchCommandError>;
  readonly getById: (
    input: ThreadMessageQueueDispatchNowInput,
  ) => Effect.Effect<ThreadMessageQueueItem | null, OrchestrationDispatchCommandError>;
  readonly listThreadIdsWithItems: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    OrchestrationDispatchCommandError
  >;
  readonly snapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadMessageQueueSnapshot, OrchestrationDispatchCommandError>;
  readonly streamThread: (
    input: ThreadMessageQueueSubscribeInput,
  ) => Stream.Stream<ThreadMessageQueueStreamItem, OrchestrationDispatchCommandError>;
}

export class ThreadMessageQueue extends Context.Service<
  ThreadMessageQueue,
  ThreadMessageQueueShape
>()("t3/orchestration/Services/ThreadMessageQueue") {}
