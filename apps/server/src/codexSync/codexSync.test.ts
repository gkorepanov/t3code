import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  extractImportedThreadMessages,
  listCodexThreads,
  readResumeCursorThreadId,
  readSessionIndexTitles,
  resolveImportedThreadTitle,
} from "./codexSync.ts";

describe("codexSync helpers", () => {
  it("lists discovered Codex threads from sqlite rows", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-sync-db-"));
    const dbPath = path.join(tempDir, "state_5.sqlite");
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        first_user_message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL
      );
    `);
    database.exec(`
      INSERT INTO threads (id, cwd, title, first_user_message, created_at, updated_at, archived)
      VALUES
        ('codex-2', '/tmp/two', 'Two', 'second', 1773230001, 1773230002, 1),
        ('codex-1', '/tmp/one', 'One', 'first', 1773230000, 1773230001, 0);
    `);
    database.close();

    const threads = listCodexThreads(dbPath);

    expect(threads).toEqual([
      {
        codexThreadId: "codex-1",
        cwd: "/tmp/one",
        title: "One",
        firstUserMessage: "first",
        createdAt: "2026-03-11T11:53:20.000Z",
        updatedAt: "2026-03-11T11:53:21.000Z",
        archived: false,
      },
      {
        codexThreadId: "codex-2",
        cwd: "/tmp/two",
        title: "Two",
        firstUserMessage: "second",
        createdAt: "2026-03-11T11:53:21.000Z",
        updatedAt: "2026-03-11T11:53:22.000Z",
        archived: true,
      },
    ]);
  });

  it("reads fallback titles from session_index.jsonl", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-sync-index-"));
    fs.writeFileSync(
      path.join(tempDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "codex-1", thread_name: "Title one" }),
        "not-json",
        JSON.stringify({ id: "codex-2", thread_name: "Title two" }),
      ].join("\n"),
      "utf8",
    );

    expect(readSessionIndexTitles(tempDir)).toEqual(
      new Map([
        ["codex-1", "Title one"],
        ["codex-2", "Title two"],
      ]),
    );
  });

  it("extracts ordered user and assistant transcript messages", () => {
    const messages = extractImportedThreadMessages({
      providerThreadId: "codex-1",
      threadCreatedAt: "2026-03-10T18:06:40.000Z",
      threadUpdatedAt: "2026-03-10T18:06:50.000Z",
      snapshot: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turns: [
          {
            id: TurnId.makeUnsafe("turn-1"),
            items: [
              {
                type: "userMessage",
                content: [
                  { type: "text", text: "hello " },
                  { type: "text", text: "world" },
                ],
              },
              { type: "reasoning", text: "ignore me" },
              { type: "assistantMessage", content: [{ type: "text", text: "done" }] },
            ],
          },
          {
            id: TurnId.makeUnsafe("turn-2"),
            items: [{ type: "assistant_message", text: "follow up" }],
          },
        ],
      },
    });

    expect(
      messages.map((message) => ({
        id: message.messageId,
        role: message.role,
        text: message.text,
        turnId: message.turnId,
      })),
    ).toEqual([
      {
        id: "user:codex-1:turn-1:1",
        role: "user",
        text: "hello world",
        turnId: "turn-1",
      },
      {
        id: "assistant:codex-1:turn-1:3",
        role: "assistant",
        text: "done",
        turnId: "turn-1",
      },
      {
        id: "assistant:codex-1:turn-2:1",
        role: "assistant",
        text: "follow up",
        turnId: "turn-2",
      },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.createdAt <= messages[1]!.createdAt).toBe(true);
    expect(messages[1]!.createdAt <= messages[2]!.createdAt).toBe(true);
  });

  it("strips Codex wrapper text from imported user messages and titles", () => {
    const messages = extractImportedThreadMessages({
      providerThreadId: "codex-2",
      threadCreatedAt: "2026-03-10T18:06:40.000Z",
      threadUpdatedAt: "2026-03-10T18:06:50.000Z",
      snapshot: {
        threadId: ThreadId.makeUnsafe("thread-2"),
        turns: [
          {
            id: TurnId.makeUnsafe("turn-1"),
            items: [
              {
                type: "userMessage",
                text: [
                  "<environment_context>",
                  "  <cwd>/tmp/demo</cwd>",
                  "</environment_context>",
                  "",
                  "## My request for Codex:",
                  "Fix the failing test",
                ].join("\n"),
              },
              {
                type: "assistantMessage",
                text: "Working on it",
              },
            ],
          },
          {
            id: TurnId.makeUnsafe("turn-2"),
            items: [
              {
                type: "user_message",
                text: [
                  "# Files mentioned by the user:",
                  "[foo.py](/tmp/foo.py)",
                  "",
                  "## My request for Codex:",
                  "Read the file and patch it",
                ].join("\n"),
              },
            ],
          },
        ],
      },
    });

    expect(messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: "user", text: "Fix the failing test" },
      { role: "assistant", text: "Working on it" },
      { role: "user", text: "Read the file and patch it" },
    ]);
    expect(
      resolveImportedThreadTitle({
        title: null,
        indexTitle: undefined,
        firstUserMessage: [
          "<environment_context>",
          "  <cwd>/tmp/demo</cwd>",
          "</environment_context>",
          "",
          "## My request for Codex:",
          "Fix the failing test",
        ].join("\n"),
      }),
    ).toBe("Fix the failing test");
  });

  it("resolves dedupe cursor ids and thread titles", () => {
    expect(readResumeCursorThreadId({ threadId: "codex-1" })).toBe("codex-1");
    expect(readResumeCursorThreadId({ threadId: "   codex-2   " })).toBe("codex-2");
    expect(readResumeCursorThreadId(null)).toBeUndefined();
    expect(
      resolveImportedThreadTitle({
        title: null,
        indexTitle: "Indexed title",
        firstUserMessage: "Fallback title",
      }),
    ).toBe("Indexed title");
  });
});
