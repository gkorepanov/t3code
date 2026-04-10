import { describe, expect, it } from "vitest";

import { matchAbsoluteFileRoute } from "./absoluteFileRoute";

describe("matchAbsoluteFileRoute", () => {
  it("matches likely absolute filesystem paths", () => {
    expect(matchAbsoluteFileRoute("/home/julius/project/src/main.ts", "GET")).toEqual({
      kind: "matched",
      filePath: "/home/julius/project/src/main.ts",
    });
  });

  it("strips line and column suffixes from matched file paths", () => {
    expect(matchAbsoluteFileRoute("/Users/julius/project/AGENTS.md:42:7", "GET")).toEqual({
      kind: "matched",
      filePath: "/Users/julius/project/AGENTS.md",
    });
  });

  it("does not treat app routes as absolute file paths", () => {
    expect(matchAbsoluteFileRoute("/chat/thread-123", "GET")).toEqual({
      kind: "unmatched",
    });
  });

  it("rejects matched paths with relative segments", () => {
    expect(matchAbsoluteFileRoute("/home/julius/project/../secrets.txt", "GET")).toEqual({
      kind: "invalid",
    });
  });
});
