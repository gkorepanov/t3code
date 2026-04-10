import { describe, expect, it } from "vitest";

import { matchAbsoluteFileRoute } from "./absoluteFileRoute";

describe("matchAbsoluteFileRoute", () => {
  it("matches explicit /file routes for absolute filesystem paths", () => {
    expect(matchAbsoluteFileRoute("/file/home/julius/project/src/main.ts", "GET")).toEqual({
      kind: "matched",
      filePath: "/home/julius/project/src/main.ts",
    });
  });

  it("matches explicit /file routes for repo-style paths", () => {
    expect(matchAbsoluteFileRoute("/file/repo/project/src/main.ts", "GET")).toEqual({
      kind: "matched",
      filePath: "/repo/project/src/main.ts",
    });
  });

  it("matches explicit /file routes for workspace-style paths", () => {
    expect(
      matchAbsoluteFileRoute("/file/workspace/.codex/skills/review-follow-up/SKILL.md", "GET"),
    ).toEqual({
      kind: "matched",
      filePath: "/workspace/.codex/skills/review-follow-up/SKILL.md",
    });
  });

  it("strips line and column suffixes from matched file paths", () => {
    expect(matchAbsoluteFileRoute("/file/Users/julius/project/AGENTS.md:42:7", "GET")).toEqual({
      kind: "matched",
      filePath: "/Users/julius/project/AGENTS.md",
    });
  });

  it("does not treat app routes as file paths", () => {
    expect(matchAbsoluteFileRoute("/chat/thread-123", "GET")).toEqual({
      kind: "unmatched",
    });
  });

  it("does not treat bare absolute paths as file routes", () => {
    expect(matchAbsoluteFileRoute("/home/julius/project/src/main.ts", "GET")).toEqual({
      kind: "unmatched",
    });
  });

  it("does not treat built asset routes as absolute file paths", () => {
    expect(matchAbsoluteFileRoute("/assets/index-Dtd-1hCt.css", "GET")).toEqual({
      kind: "unmatched",
    });
  });

  it("rejects matched paths with relative segments", () => {
    expect(matchAbsoluteFileRoute("/file/home/julius/project/../secrets.txt", "GET")).toEqual({
      kind: "invalid",
    });
  });
});
