import type {
  ServerArchiveCodexThreadInput,
  ServerArchiveCodexThreadResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface CodexThreadArchiveShape {
  readonly archiveThread: (
    input: ServerArchiveCodexThreadInput,
  ) => Effect.Effect<ServerArchiveCodexThreadResult, Error>;
}

export class CodexThreadArchive extends ServiceMap.Service<
  CodexThreadArchive,
  CodexThreadArchiveShape
>()("t3/codexSync/Services/CodexThreadArchive") {}
