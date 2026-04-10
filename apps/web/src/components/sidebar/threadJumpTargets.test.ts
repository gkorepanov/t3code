import { describe, expect, it } from "vitest";

import { selectThreadJumpThreadIds } from "./threadJumpTargets";

describe("selectThreadJumpThreadIds", () => {
  it("keeps the freshest threads while preserving rendered order", () => {
    expect(
      selectThreadJumpThreadIds(
        [
          {
            id: "thread-3",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-03T00:00:00.000Z",
            messages: [],
          },
          {
            id: "thread-1",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-05T00:00:00.000Z",
            messages: [],
          },
          {
            id: "thread-2",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-04T00:00:00.000Z",
            messages: [],
          },
        ],
        "updated_at",
        2,
      ),
    ).toEqual(["thread-1", "thread-2"]);
  });
});
