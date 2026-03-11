import type { ServerSyncCodexThreadsInput, ServerSyncCodexThreadsResult } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface CodexThreadSyncShape {
  readonly syncThreads: (
    input: ServerSyncCodexThreadsInput,
  ) => Effect.Effect<ServerSyncCodexThreadsResult, Error>;
}

export class CodexThreadSync extends ServiceMap.Service<CodexThreadSync, CodexThreadSyncShape>()(
  "t3/codexSync/Services/CodexThreadSync",
) {}
