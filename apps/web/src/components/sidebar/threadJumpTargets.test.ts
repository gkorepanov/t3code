import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import { selectThreadJumpThreadIds } from "./threadJumpTargets";

describe("selectThreadJumpThreadIds", () => {
  it("keeps the freshest threads while preserving rendered order", () => {
    expect(
      selectThreadJumpThreadIds(
        [
          {
            id: ThreadId.makeUnsafe("thread-3"),
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
            messages: [],
          },
          {
            id: ThreadId.makeUnsafe("thread-1"),
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-05T00:00:00.000Z",
            messages: [],
          },
          {
            id: ThreadId.makeUnsafe("thread-2"),
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-04T00:00:00.000Z",
            messages: [],
          },
        ],
        "updated_at",
        2,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")]);
  });
});
