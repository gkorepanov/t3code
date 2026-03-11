import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImportedThreadMessage, TurnId } from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

export interface CodexDiscoveredThread {
  readonly codexThreadId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly firstUserMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

type SqliteThreadRow = {
  readonly id: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly firstUserMessage: string | null;
  readonly createdAtSeconds: number;
  readonly updatedAtSeconds: number;
  readonly archived: number;
};

type ImportedMessageDraft = Omit<ImportedThreadMessage, "createdAt" | "updatedAt"> & {
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toIsoFromUnixSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) {
    return "item";
  }
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toImportedRole(raw: unknown): "user" | "assistant" | null {
  const type = normalizeItemType(raw);
  if (type.includes("user")) {
    return "user";
  }
  if (type.includes("agent message") || type.includes("assistant")) {
    return "assistant";
  }
  return null;
}

function collectTextParts(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextParts(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  if (typeof record.text === "string" && record.text.length > 0) {
    return [record.text];
  }
  if (typeof record.message === "string" && record.message.length > 0) {
    return [record.message];
  }
  return [
    ...collectTextParts(record.content),
    ...collectTextParts(record.parts),
    ...collectTextParts(record.messages),
  ];
}

function extractItemText(item: Record<string, unknown>): string {
  const contentText = collectTextParts(item.content);
  if (contentText.length > 0) {
    return contentText.join("");
  }
  const partText = collectTextParts(item.parts);
  if (partText.length > 0) {
    return partText.join("");
  }
  const directText = [asString(item.text), asString(item.message)].filter(
    (entry): entry is string => entry !== undefined && entry.length > 0,
  );
  return directText.join("");
}

function stripLeadingEnvironmentContext(text: string): string {
  let normalized = text.trimStart();
  while (normalized.startsWith("<environment_context>")) {
    const endIndex = normalized.indexOf("</environment_context>");
    if (endIndex < 0) {
      return "";
    }
    normalized = normalized.slice(endIndex + "</environment_context>".length).trimStart();
  }
  return normalized;
}

function stripLeadingFilesMentionedBlock(text: string): string {
  const normalized = text.trimStart();
  const header = "# Files mentioned by the user:";
  if (!normalized.startsWith(header)) {
    return normalized;
  }

  const marker = "\n## My request for Codex:";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return normalized;
  }

  return normalized.slice(markerIndex + marker.length).trimStart();
}

function normalizeImportedUserText(text: string): string {
  let normalized = stripLeadingEnvironmentContext(text);
  normalized = stripLeadingFilesMentionedBlock(normalized);
  if (normalized.startsWith("## My request for Codex:")) {
    normalized = normalized.slice("## My request for Codex:".length).trimStart();
  }
  return normalized.trim();
}

function extractIsoDate(value: unknown, keys: readonly string[]): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const raw = asString(record[key]);
    if (!raw) {
      continue;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

function normalizeThreadTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function assignMessageTimestamps(
  messages: ReadonlyArray<ImportedMessageDraft>,
  threadCreatedAt: string,
  threadUpdatedAt: string,
): ImportedThreadMessage[] {
  const fallbackStart = normalizeThreadTimestamp(threadCreatedAt, Date.now());
  const fallbackEnd = Math.max(
    fallbackStart,
    normalizeThreadTimestamp(threadUpdatedAt, fallbackStart),
  );
  const step =
    messages.length > 1
      ? Math.max(1, Math.floor((fallbackEnd - fallbackStart) / (messages.length - 1)))
      : 0;
  let lastAssignedMs = fallbackStart;

  return messages.map((message, index) => {
    const fallbackCreatedMs = messages.length === 1 ? fallbackEnd : fallbackStart + step * index;
    const hintedCreatedMs = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    const createdMs = Math.max(
      lastAssignedMs,
      Number.isNaN(hintedCreatedMs) ? fallbackCreatedMs : hintedCreatedMs,
    );
    const hintedUpdatedMs = message.updatedAt ? Date.parse(message.updatedAt) : Number.NaN;
    const updatedMs = Math.max(
      createdMs,
      Number.isNaN(hintedUpdatedMs) ? createdMs : hintedUpdatedMs,
    );
    lastAssignedMs = updatedMs;
    return {
      ...message,
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(updatedMs).toISOString(),
    };
  });
}

function toMessageId(input: {
  readonly providerThreadId: string;
  readonly turnId: string | null;
  readonly itemIndex: number;
  readonly role: "user" | "assistant";
}) {
  return MessageId.makeUnsafe(
    `${input.role}:${input.providerThreadId}:${input.turnId ?? "no-turn"}:${input.itemIndex}`,
  );
}

export function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  const threadId = record ? asString(record.threadId) : undefined;
  return threadId && threadId.trim().length > 0 ? threadId.trim() : undefined;
}

export function resolveImportedThreadTitle(input: {
  readonly title: string | null;
  readonly indexTitle: string | undefined;
  readonly firstUserMessage: string | null;
}): string {
  const candidates = [
    input.title,
    input.indexTitle,
    input.firstUserMessage
      ? normalizeImportedUserText(input.firstUserMessage)
      : input.firstUserMessage,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "Imported Codex thread";
}

export function listCodexThreads(dbPath: string): CodexDiscoveredThread[] {
  const database = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const statement = database.prepare(`
      SELECT
        id,
        cwd,
        title,
        first_user_message AS firstUserMessage,
        created_at AS createdAtSeconds,
        updated_at AS updatedAtSeconds,
        archived
      FROM threads
      ORDER BY updated_at ASC, id ASC
    `);
    const rows = statement.all() as SqliteThreadRow[];
    return rows.map((row) => ({
      codexThreadId: row.id,
      cwd: row.cwd,
      title: row.title,
      firstUserMessage: row.firstUserMessage,
      createdAt: toIsoFromUnixSeconds(row.createdAtSeconds),
      updatedAt: toIsoFromUnixSeconds(row.updatedAtSeconds),
      archived: row.archived === 1,
    }));
  } finally {
    database.close();
  }
}

export function readSessionIndexTitles(codexHomePath: string): Map<string, string> {
  const sessionIndexPath = path.join(codexHomePath, "session_index.jsonl");
  if (!fs.existsSync(sessionIndexPath)) {
    return new Map();
  }

  const titles = new Map<string, string>();
  const lines = fs.readFileSync(sessionIndexPath, "utf8").split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const id = asString(record.id)?.trim();
      const title = asString(record.thread_name)?.trim();
      if (id && title) {
        titles.set(id, title);
      }
    } catch {
      // Best-effort only; ignore malformed lines.
    }
  }
  return titles;
}

export function extractImportedThreadMessages(input: {
  readonly providerThreadId: string;
  readonly snapshot: ProviderThreadSnapshot;
  readonly threadCreatedAt: string;
  readonly threadUpdatedAt: string;
}): ImportedThreadMessage[] {
  const drafts: ImportedMessageDraft[] = [];

  input.snapshot.turns.forEach((turn, turnIndex) => {
    const turnRecord = asRecord(turn);
    const turnId = (turn.id ?? null) as TurnId | null;
    const turnCreatedAt =
      extractIsoDate(turnRecord, ["createdAt", "created_at", "timestamp", "occurredAt"]) ??
      undefined;
    const turnUpdatedAt =
      extractIsoDate(turnRecord, ["updatedAt", "updated_at", "timestamp", "occurredAt"]) ??
      turnCreatedAt;

    turn.items.forEach((item, itemIndex) => {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        return;
      }
      const role = toImportedRole(itemRecord.type ?? itemRecord.itemType);
      if (!role) {
        return;
      }
      const rawText = extractItemText(itemRecord);
      const text = role === "user" ? normalizeImportedUserText(rawText) : rawText.trim();
      if (text.length === 0) {
        return;
      }
      const itemCreatedAt =
        extractIsoDate(itemRecord, ["createdAt", "created_at", "timestamp", "occurredAt"]) ??
        turnCreatedAt;
      const itemUpdatedAt =
        extractIsoDate(itemRecord, ["updatedAt", "updated_at", "timestamp", "occurredAt"]) ??
        turnUpdatedAt;
      drafts.push({
        messageId: toMessageId({
          providerThreadId: input.providerThreadId,
          turnId: turnId ?? `turn-${turnIndex + 1}`,
          itemIndex: itemIndex + 1,
          role,
        }),
        role,
        text,
        turnId,
        ...(itemCreatedAt !== undefined
          ? {
              createdAt: itemCreatedAt,
            }
          : {}),
        ...(itemUpdatedAt !== undefined
          ? {
              updatedAt: itemUpdatedAt,
            }
          : {}),
      });
    });
  });

  return assignMessageTimestamps(drafts, input.threadCreatedAt, input.threadUpdatedAt);
}
