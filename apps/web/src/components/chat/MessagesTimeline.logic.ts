export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export interface RenderedTimelineMessageRow {
  rowIndex: number;
  top: number;
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

export function findAdjacentRenderedMessageRowIndex(
  rows: ReadonlyArray<RenderedTimelineMessageRow>,
  scrollTop: number,
  direction: -1 | 1,
): number | null {
  if (rows.length === 0) {
    return null;
  }

  const anchor = Number.isFinite(scrollTop) ? scrollTop : 0;

  if (direction < 0) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row && row.top < anchor) {
        return row.rowIndex;
      }
    }
    return null;
  }

  for (const row of rows) {
    if (row.top > anchor) {
      return row.rowIndex;
    }
  }

  const firstRow = rows[0];
  if (firstRow && firstRow.top > anchor) {
    return firstRow.rowIndex;
  }
  return null;
}
