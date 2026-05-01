import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "turn-details";
      id: string;
      createdAt: string;
      finalMessageId: MessageId;
      collapsedEntries: CollapsedTurnDetailsEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export type CollapsedTurnDetailsEntry =
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const collapsePlan = deriveTurnDetailsCollapsePlan({
    timelineEntries: input.timelineEntries,
    activeTurnInProgress: input.activeTurnInProgress === true,
    activeTurnId: input.activeTurnId ?? null,
  });

  const pushMessageRow = (timelineEntry: Extract<TimelineEntry, { kind: "message" }>) => {
    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (collapsePlan.collapsedIndexSet.has(index)) {
      continue;
    }

    if (timelineEntry.kind === "message" && isTurnDetailsFinalEntry(collapsePlan, index)) {
      const collapsedEntries = collapsePlan.collapsedEntriesByFinalIndex.get(index) ?? [];
      if (collapsedEntries.length > 0) {
        nextRows.push({
          kind: "turn-details",
          id: `turn-details:${timelineEntry.message.id}`,
          createdAt: collapsedEntries[0]?.createdAt ?? timelineEntry.createdAt,
          finalMessageId: timelineEntry.message.id,
          collapsedEntries,
        });
      }
      pushMessageRow(timelineEntry);
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        if (collapsePlan.collapsedIndexSet.has(cursor)) break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    pushMessageRow(timelineEntry);
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

interface TurnDetailsCollapsePlan {
  responseKeyByIndex: ReadonlyMap<number, string>;
  finalMessageIdByResponseKey: ReadonlyMap<string, MessageId>;
  finalIndexByResponseKey: ReadonlyMap<string, number>;
  collapsedIndexSet: ReadonlySet<number>;
  collapsedEntriesByFinalIndex: ReadonlyMap<number, CollapsedTurnDetailsEntry[]>;
}

function deriveTurnDetailsCollapsePlan(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null;
}): TurnDetailsCollapsePlan {
  const responseKeyByIndex = new Map<number, string>();
  const finalMessageIdByResponseKey = new Map<string, MessageId>();
  const finalIndexByResponseKey = new Map<string, number>();
  let responseKey: string | null = null;
  let latestResponseKey: string | null = null;

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) continue;

    if (timelineEntry.kind === "message" && timelineEntry.message.role === "user") {
      responseKey = `response:${timelineEntry.message.id}`;
    }

    if (!responseKey) {
      continue;
    }
    responseKeyByIndex.set(index, responseKey);
    latestResponseKey = responseKey;

    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    if (timelineEntry.message.streaming) {
      continue;
    }
    if (
      input.activeTurnInProgress &&
      input.activeTurnId !== null &&
      timelineEntry.message.turnId === input.activeTurnId
    ) {
      continue;
    }
    finalMessageIdByResponseKey.set(responseKey, timelineEntry.message.id);
    finalIndexByResponseKey.set(responseKey, index);
  }

  if (input.activeTurnInProgress && latestResponseKey !== null) {
    finalMessageIdByResponseKey.delete(latestResponseKey);
    finalIndexByResponseKey.delete(latestResponseKey);
  }

  const collapsedIndexSet = new Set<number>();
  const collapsedEntriesByFinalIndex = new Map<number, CollapsedTurnDetailsEntry[]>();
  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry || timelineEntry.kind === "proposed-plan") {
      continue;
    }
    const finalState = responseFinalState(
      {
        responseKeyByIndex,
        finalMessageIdByResponseKey,
        finalIndexByResponseKey,
        collapsedIndexSet,
        collapsedEntriesByFinalIndex,
      },
      index,
    );
    if (!finalState || !shouldCollapseTimelineEntry(timelineEntry, finalState.messageId)) {
      continue;
    }

    collapsedIndexSet.add(index);
    const entries = collapsedEntriesByFinalIndex.get(finalState.index) ?? [];
    entries.push(toCollapsedTurnDetailsEntry(timelineEntry));
    collapsedEntriesByFinalIndex.set(finalState.index, entries);
  }

  return {
    responseKeyByIndex,
    finalMessageIdByResponseKey,
    finalIndexByResponseKey,
    collapsedIndexSet,
    collapsedEntriesByFinalIndex,
  };
}

function responseFinalState(
  collapsePlan: TurnDetailsCollapsePlan,
  index: number,
): { messageId: MessageId; index: number } | null {
  const responseKey = collapsePlan.responseKeyByIndex.get(index);
  if (!responseKey) {
    return null;
  }
  const messageId = collapsePlan.finalMessageIdByResponseKey.get(responseKey);
  const finalIndex = collapsePlan.finalIndexByResponseKey.get(responseKey);
  return messageId && finalIndex !== undefined ? { messageId, index: finalIndex } : null;
}

function shouldCollapseTimelineEntry(
  timelineEntry: Extract<TimelineEntry, { kind: "message" | "work" }>,
  finalMessageId: MessageId,
): boolean {
  if (timelineEntry.kind === "work") {
    return true;
  }
  return (
    timelineEntry.kind === "message" &&
    timelineEntry.message.role === "assistant" &&
    timelineEntry.message.id !== finalMessageId
  );
}

function isTurnDetailsFinalEntry(collapsePlan: TurnDetailsCollapsePlan, index: number): boolean {
  const finalState = responseFinalState(collapsePlan, index);
  return finalState !== null && index === finalState.index;
}

function toCollapsedTurnDetailsEntry(
  timelineEntry: Extract<TimelineEntry, { kind: "message" | "work" }>,
): CollapsedTurnDetailsEntry {
  if (timelineEntry.kind === "work") {
    return {
      kind: "work",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      entry: timelineEntry.entry,
    };
  }
  return {
    kind: "message",
    id: timelineEntry.id,
    createdAt: timelineEntry.createdAt,
    message: timelineEntry.message,
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return a.groupedEntries === (b as typeof a).groupedEntries;

    case "turn-details": {
      const bm = b as typeof a;
      return a.finalMessageId === bm.finalMessageId && a.collapsedEntries === bm.collapsedEntries;
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
