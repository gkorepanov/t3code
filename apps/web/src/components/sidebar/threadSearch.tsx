import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Thread } from "../../types";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";

const EMPTY_THREAD_SEARCH_MATCHES = new Map<string, SidebarThreadSearchMatch>();
const EMPTY_MATCHED_PROJECT_KEYS = new Set<string>();
const MESSAGE_SNIPPET_MAX_CHARS = 84;
const MESSAGE_SNIPPET_CONTEXT_CHARS = 22;
const THREAD_SEARCH_COMMIT_DEBOUNCE_MS = 700;

type ThreadSearchSource = "title" | "message";

interface SearchableThreadSearchText {
  cleanedText: string;
  normalizedText: string;
}

interface ThreadSearchTextMatch {
  cleanedText: string;
  positions: readonly number[];
}

interface ThreadSearchDisplayWindow {
  prefix: string;
  start: number;
  text: string;
  suffix: string;
}

export interface SidebarThreadSearchSegment {
  text: string;
  matched: boolean;
}

export interface SidebarThreadSearchMatch {
  threadKey: string;
  projectKey: string;
  source: ThreadSearchSource;
  segments: readonly SidebarThreadSearchSegment[];
}

export interface SidebarThreadSearchResult {
  hasActiveSearch: boolean;
  matchedProjectKeys: ReadonlySet<string>;
  matchesByThreadKey: ReadonlyMap<string, SidebarThreadSearchMatch>;
}

const EMPTY_THREAD_SEARCH_RESULT: SidebarThreadSearchResult = {
  hasActiveSearch: false,
  matchedProjectKeys: EMPTY_MATCHED_PROJECT_KEYS,
  matchesByThreadKey: EMPTY_THREAD_SEARCH_MATCHES,
};

export function normalizeThreadSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function cleanSearchText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function toSearchableThreadSearchText(text: string): SearchableThreadSearchText | null {
  const cleanedText = cleanSearchText(text);
  if (!cleanedText) {
    return null;
  }

  return {
    cleanedText,
    normalizedText: cleanedText.toLocaleLowerCase(),
  };
}

function range(start: number, endExclusive: number): number[] {
  return Array.from({ length: Math.max(0, endExclusive - start) }, (_, index) => start + index);
}

function matchThreadSearchText(
  text: SearchableThreadSearchText | null,
  normalizedQuery: string,
): ThreadSearchTextMatch | null {
  if (!text) {
    return null;
  }

  const exactMatchStart = text.normalizedText.indexOf(normalizedQuery);
  if (exactMatchStart >= 0) {
    return {
      cleanedText: text.cleanedText,
      positions: range(exactMatchStart, exactMatchStart + normalizedQuery.length),
    };
  }

  return null;
}

function buildDisplayWindow(
  text: string,
  positions: readonly number[],
  maxChars: number,
): ThreadSearchDisplayWindow {
  if (positions.length === 0 || text.length <= maxChars) {
    return {
      prefix: "",
      start: 0,
      text,
      suffix: "",
    };
  }

  const firstMatch = positions[0]!;
  const lastMatch = positions.at(-1)!;
  let start = Math.max(0, firstMatch - MESSAGE_SNIPPET_CONTEXT_CHARS);
  let end = Math.min(
    text.length,
    Math.max(lastMatch + MESSAGE_SNIPPET_CONTEXT_CHARS + 1, start + maxChars),
  );

  if (end - start > maxChars) {
    end = start + maxChars;
  }
  if (lastMatch >= end) {
    end = Math.min(text.length, lastMatch + 1);
    start = Math.max(0, end - maxChars);
  }
  if (firstMatch < start) {
    start = firstMatch;
    end = Math.min(text.length, start + maxChars);
  }

  return {
    prefix: start > 0 ? "..." : "",
    start,
    text: text.slice(start, end),
    suffix: end < text.length ? "..." : "",
  };
}

function buildHighlightedSegments(
  text: string,
  positions: readonly number[],
  options?: { maxChars?: number },
): SidebarThreadSearchSegment[] {
  const displayWindow = buildDisplayWindow(
    text,
    positions,
    options?.maxChars ?? Number.POSITIVE_INFINITY,
  );
  const relativePositions = new Set(
    positions
      .filter(
        (position) =>
          position >= displayWindow.start &&
          position < displayWindow.start + displayWindow.text.length,
      )
      .map((position) => displayWindow.prefix.length + position - displayWindow.start),
  );
  const displayText = `${displayWindow.prefix}${displayWindow.text}${displayWindow.suffix}`;
  if (displayText.length === 0) {
    return [];
  }

  const segments: SidebarThreadSearchSegment[] = [];
  let currentMatched = relativePositions.has(0);
  let currentText = "";

  for (const [index, char] of Array.from(displayText).entries()) {
    const matched = relativePositions.has(index);
    if (matched !== currentMatched && currentText.length > 0) {
      segments.push({ text: currentText, matched: currentMatched });
      currentText = "";
    }
    currentMatched = matched;
    currentText += char;
  }

  if (currentText.length > 0) {
    segments.push({ text: currentText, matched: currentMatched });
  }

  return segments;
}

function buildThreadSearchMatch(
  input: Omit<SidebarThreadSearchMatch, "segments"> & {
    text: string;
    positions: readonly number[];
  },
): SidebarThreadSearchMatch {
  return {
    threadKey: input.threadKey,
    projectKey: input.projectKey,
    source: input.source,
    segments: buildHighlightedSegments(
      input.text,
      input.positions,
      input.source === "message" ? { maxChars: MESSAGE_SNIPPET_MAX_CHARS } : undefined,
    ),
  };
}

export function searchSidebarThreads(input: {
  query: string;
  threads: readonly Thread[];
  logicalProjectKeyByPhysicalProjectKey: ReadonlyMap<string, string>;
}): SidebarThreadSearchResult {
  const normalizedQuery = normalizeThreadSearchQuery(input.query);
  if (!normalizedQuery) {
    return EMPTY_THREAD_SEARCH_RESULT;
  }

  const matchedProjectKeys = new Set<string>();
  const matchesByThreadKey = new Map<string, SidebarThreadSearchMatch>();

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const physicalProjectKey = scopedProjectKey(
      scopeProjectRef(thread.environmentId, thread.projectId),
    );
    const projectKey =
      input.logicalProjectKeyByPhysicalProjectKey.get(physicalProjectKey) ?? physicalProjectKey;

    const titleMatch = matchThreadSearchText(
      toSearchableThreadSearchText(thread.title),
      normalizedQuery,
    );
    if (titleMatch) {
      matchedProjectKeys.add(projectKey);
      matchesByThreadKey.set(
        threadKey,
        buildThreadSearchMatch({
          threadKey,
          projectKey,
          source: "title",
          text: titleMatch.cleanedText,
          positions: titleMatch.positions,
        }),
      );
      continue;
    }

    for (const message of thread.messages) {
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }

      const searchableMessage = toSearchableThreadSearchText(message.text);
      if (!searchableMessage) {
        continue;
      }

      const messageMatch = matchThreadSearchText(searchableMessage, normalizedQuery);
      if (!messageMatch) {
        continue;
      }

      matchedProjectKeys.add(projectKey);
      matchesByThreadKey.set(
        threadKey,
        buildThreadSearchMatch({
          threadKey,
          projectKey,
          source: "message",
          text: messageMatch.cleanedText,
          positions: messageMatch.positions,
        }),
      );
      break;
    }
  }

  return {
    hasActiveSearch: true,
    matchedProjectKeys,
    matchesByThreadKey,
  };
}

export function SidebarThreadSearchInput({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState(query);
  const [debouncedDraftQuery] = useDebouncedValue(draftQuery, {
    wait: THREAD_SEARCH_COMMIT_DEBOUNCE_MS,
  });

  useEffect(() => {
    onQueryChange(debouncedDraftQuery);
  }, [debouncedDraftQuery, onQueryChange]);

  return (
    <div className="mb-2 px-1">
      <InputGroup className="rounded-xl border-border/70 bg-sidebar-accent/20 shadow-none transition-colors focus-within:border-ring/70 focus-within:bg-background">
        <InputGroupAddon className="overflow-visible ps-2.5 text-muted-foreground/55">
          <InputGroupText className="[&_svg]:mx-0">
            <SearchIcon className="size-3.5" />
          </InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          size="sm"
          value={draftQuery}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search threads and messages..."
          aria-label="Search threads and messages"
          onChange={(event) => {
            setDraftQuery(event.target.value);
          }}
        />
        {draftQuery.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <button
              type="button"
              aria-label="Clear thread search"
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => {
                setDraftQuery("");
                onQueryChange("");
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}

export function SidebarThreadSearchLabel({
  threadTitle,
  match,
}: {
  threadTitle: string;
  match: SidebarThreadSearchMatch | null;
}) {
  const segments = match?.segments;
  if (!segments || segments.length === 0) {
    return <span className="min-w-0 flex-1 truncate text-xs">{threadTitle}</span>;
  }

  let segmentOffset = 0;

  return (
    <span
      className="min-w-0 flex-1 truncate text-xs"
      title={match.source === "message" ? threadTitle : undefined}
    >
      {segments.map((segment) => {
        const key = `${segmentOffset}:${segment.matched ? "1" : "0"}:${segment.text}`;
        segmentOffset += segment.text.length;
        return segment.matched ? (
          <strong key={key} className="font-semibold text-foreground">
            {segment.text}
          </strong>
        ) : (
          <span key={key}>{segment.text}</span>
        );
      })}
    </span>
  );
}
