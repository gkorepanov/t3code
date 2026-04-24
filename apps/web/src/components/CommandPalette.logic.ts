import { type KeybindingCommand, type FilesystemBrowseEntry } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { type ReactNode } from "react";
import { sortThreads } from "../lib/threadSort";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { type ChatMessage, type Project, type SidebarThreadSummary, type Thread } from "../types";

export const RECENT_THREAD_LIMIT = 12;
export const ITEM_ICON_CLASS = "size-4 text-muted-foreground/80";
export const ADDON_ICON_CLASS = "size-4";
const MESSAGE_SNIPPET_MAX_CHARS = 120;
const MESSAGE_SNIPPET_CONTEXT_CHARS = 36;

export interface CommandPaletteTextSegment {
  readonly text: string;
  readonly matched: boolean;
}

interface CommandPaletteThreadSearchPayload {
  readonly title: string;
  readonly messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>;
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: string;
  readonly titleSegments?: ReadonlyArray<CommandPaletteTextSegment>;
  readonly descriptionSegments?: ReadonlyArray<CommandPaletteTextSegment>;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  /** Optional content rendered inline before the title text. */
  readonly titleLeadingContent?: ReactNode;
  /** Optional content rendered inline after the title text (before the timestamp). */
  readonly titleTrailingContent?: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly threadSearch?: CommandPaletteThreadSearchPayload;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly initialQuery?: string;
}

export type CommandPaletteMode = "root" | "root-browse" | "submenu" | "submenu-browse";

export function filterBrowseEntries(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseFilterQuery: string;
  highlightedItemValue: string | null;
}): {
  filteredEntries: FilesystemBrowseEntry[];
  highlightedEntry: FilesystemBrowseEntry | null;
  exactEntry: FilesystemBrowseEntry | null;
} {
  const lowerFilter = input.browseFilterQuery.toLowerCase();
  const showHidden = input.browseFilterQuery.startsWith(".");

  const filteredEntries = input.browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  let highlightedEntry: FilesystemBrowseEntry | null = null;
  if (input.highlightedItemValue?.startsWith("browse:")) {
    const highlightedPath = input.highlightedItemValue.slice("browse:".length);
    highlightedEntry = filteredEntries.find((entry) => entry.fullPath === highlightedPath) ?? null;
  }

  const exactEntry =
    input.browseFilterQuery.length > 0
      ? (filteredEntries.find((entry) => entry.name === input.browseFilterQuery) ?? null)
      : null;

  return { filteredEntries, highlightedEntry, exactEntry };
}

function cleanSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeSearchText(value: string): string {
  return cleanSearchText(value).toLowerCase();
}

export function buildProjectActionItems(input: {
  projects: ReadonlyArray<Project>;
  valuePrefix: string;
  icon: (project: Project) => ReactNode;
  runProject: (project: Project) => Promise<void>;
}): CommandPaletteActionItem[] {
  return input.projects.map((project) => ({
    kind: "action",
    value: `${input.valuePrefix}:${project.environmentId}:${project.id}`,
    searchTerms: [project.name, project.cwd],
    title: project.name,
    description: project.cwd,
    icon: input.icon(project),
    run: async () => {
      await input.runProject(project);
    },
  }));
}

export type BuildThreadActionItemsThread = Pick<
  SidebarThreadSummary,
  "archivedAt" | "branch" | "createdAt" | "environmentId" | "id" | "projectId" | "title"
> & {
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
  messages?: Thread["messages"];
};

export function buildThreadActionItems<TThread extends BuildThreadActionItemsThread>(input: {
  threads: ReadonlyArray<TThread>;
  activeThreadId?: Thread["id"];
  projectTitleById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  icon: ReactNode;
  /** Optional content rendered inline before the title text per-thread. */
  renderLeadingContent?: (thread: TThread) => ReactNode;
  /** Optional content rendered inline after the title text per-thread. */
  renderTrailingContent?: (thread: TThread) => ReactNode;
  runThread: (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  const visibleThreads =
    input.limit === undefined ? sortedThreads : sortedThreads.slice(0, input.limit);

  return visibleThreads.map((thread) => {
    const projectTitle = input.projectTitleById.get(thread.projectId);
    const descriptionParts: string[] = [];

    if (projectTitle) {
      descriptionParts.push(projectTitle);
    }
    if (thread.branch) {
      descriptionParts.push(`#${thread.branch}`);
    }
    if (thread.id === input.activeThreadId) {
      descriptionParts.push("Current thread");
    }

    const leadingContent = input.renderLeadingContent?.(thread);
    const trailingContent = input.renderTrailingContent?.(thread);

    return Object.assign(
      {
        kind: "action" as const,
        value: `thread:${thread.id}`,
        searchTerms: [thread.title, projectTitle ?? ``, thread.branch ?? ``],
        title: thread.title,
        description: descriptionParts.join(` · `),
        timestamp: formatRelativeTimeLabel(
          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
        ),
        icon: input.icon,
      },
      leadingContent ? { titleLeadingContent: leadingContent } : {},
      trailingContent ? { titleTrailingContent: trailingContent } : {},
      thread.messages
        ? {
            threadSearch: {
              title: thread.title,
              messages: thread.messages,
            },
          }
        : {},
      {
        run: async () => {
          await input.runThread(thread);
        },
      },
    );
  });
}

interface SearchTextMatch {
  readonly cleanedText: string;
  readonly normalizedText: string;
  readonly start: number;
  readonly end: number;
}

function findSearchTextMatch(value: string, normalizedQuery: string): SearchTextMatch | null {
  const cleanedText = cleanSearchText(value);
  const normalizedText = cleanedText.toLowerCase();
  const start = normalizedText.indexOf(normalizedQuery);
  if (start < 0) {
    return null;
  }

  return {
    cleanedText,
    normalizedText,
    start,
    end: start + normalizedQuery.length,
  };
}

function rankSearchTextMatch(match: SearchTextMatch | null, normalizedQuery: string): number {
  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }
  if (match.normalizedText === normalizedQuery) {
    return 3;
  }
  if (match.normalizedText.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function buildHighlightedSegments(
  match: SearchTextMatch,
  options?: { maxChars?: number },
): CommandPaletteTextSegment[] {
  const maxChars = options?.maxChars ?? Number.POSITIVE_INFINITY;
  const contextChars = MESSAGE_SNIPPET_CONTEXT_CHARS;
  let start = 0;
  let end = match.cleanedText.length;

  if (match.cleanedText.length > maxChars) {
    start = Math.max(0, match.start - contextChars);
    end = Math.min(match.cleanedText.length, Math.max(match.end + contextChars, start + maxChars));
    if (end - start > maxChars) {
      end = start + maxChars;
    }
    if (match.end > end) {
      end = Math.min(match.cleanedText.length, match.end);
      start = Math.max(0, end - maxChars);
    }
    if (match.start < start) {
      start = match.start;
      end = Math.min(match.cleanedText.length, start + maxChars);
    }
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < match.cleanedText.length ? "..." : "";
  const displayText = `${prefix}${match.cleanedText.slice(start, end)}${suffix}`;
  const relativeStart = prefix.length + match.start - start;
  const relativeEnd = prefix.length + match.end - start;
  const segments: CommandPaletteTextSegment[] = [];

  if (relativeStart > 0) {
    segments.push({ text: displayText.slice(0, relativeStart), matched: false });
  }
  segments.push({ text: displayText.slice(relativeStart, relativeEnd), matched: true });
  if (relativeEnd < displayText.length) {
    segments.push({ text: displayText.slice(relativeEnd), matched: false });
  }

  return segments.filter((segment) => segment.text.length > 0);
}

function findBestMessageMatch(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>,
  normalizedQuery: string,
): { match: SearchTextMatch; rank: number } | null {
  let best: { match: SearchTextMatch; rank: number } | null = null;

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const match = findSearchTextMatch(message.text, normalizedQuery);
    const rank = rankSearchTextMatch(match, normalizedQuery);
    if (!match || rank === Number.NEGATIVE_INFINITY) {
      continue;
    }
    if (!best || rank > best.rank) {
      best = { match, rank };
    }
  }

  return best ? { match: best.match, rank: best.rank } : null;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchTextMatch(
      findSearchTextMatch(field, normalizedQuery),
      normalizedQuery,
    );
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

function resolveThreadSearchItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): { item: CommandPaletteActionItem | CommandPaletteSubmenuItem; rank: number } | null {
  if (!item.threadSearch) {
    return null;
  }

  const titleMatch = findSearchTextMatch(item.threadSearch.title, normalizedQuery);
  const titleRank = rankSearchTextMatch(titleMatch, normalizedQuery);
  if (titleMatch && titleRank !== Number.NEGATIVE_INFINITY) {
    return {
      item: {
        ...item,
        titleSegments: buildHighlightedSegments(titleMatch),
      },
      rank: 1_000 + titleRank,
    };
  }

  const messageMatch = findBestMessageMatch(item.threadSearch.messages, normalizedQuery);
  if (messageMatch) {
    const descriptionSegments = buildHighlightedSegments(messageMatch.match, {
      maxChars: MESSAGE_SNIPPET_MAX_CHARS,
    });
    return {
      item: {
        ...item,
        description: descriptionSegments.map((segment) => segment.text).join(""),
        descriptionSegments,
      },
      rank: 900 + messageMatch.rank,
    };
  }

  const metadataTerms = item.searchTerms.slice(1).filter((term) => term.length > 0);
  for (const [index, field] of metadataTerms.entries()) {
    const fieldRank = rankSearchTextMatch(
      findSearchTextMatch(field, normalizedQuery),
      normalizedQuery,
    );
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return {
        item,
        rank: 800 - index * 100 + fieldRank,
      };
    }
  }

  return null;
}

function resolveCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
): { item: CommandPaletteActionItem | CommandPaletteSubmenuItem; rank: number } | null {
  return item.threadSearch
    ? resolveThreadSearchItemMatch(item, normalizedQuery)
    : (() => {
        const rank = rankCommandPaletteItemMatch(item, normalizedQuery);
        return rank > 0 ? { item, rank } : null;
      })();
}

export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
  isInSubmenu: boolean;
  projectSearchItems: ReadonlyArray<CommandPaletteActionItem>;
  threadSearchItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === "actions");
    }
    return [...input.activeGroups];
  }

  let baseGroups = [...input.activeGroups];
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === "actions");
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== "recent-threads");
  }

  const searchableGroups = [...baseGroups];
  if (!input.isInSubmenu && !isActionsFilter) {
    if (input.projectSearchItems.length > 0) {
      searchableGroups.push({
        value: "projects-search",
        label: "Projects",
        items: input.projectSearchItems,
      });
    }
    if (input.threadSearchItems.length > 0) {
      searchableGroups.push({
        value: "threads-search",
        label: "Threads",
        items: input.threadSearchItems,
      });
    }
  }

  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const match = resolveCommandPaletteItemMatch(item, normalizedQuery);
        if (!match) {
          return null;
        }

        return {
          item: match.item,
          index,
          rank: match.rank,
        };
      })
      .filter(
        (entry): entry is { item: (typeof group.items)[number]; index: number; rank: number } =>
          entry !== null,
      )
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export function buildBrowseGroups(input: {
  browseEntries: ReadonlyArray<FilesystemBrowseEntry>;
  browseQuery: string;
  canBrowseUp: boolean;
  upIcon: ReactNode;
  directoryIcon: ReactNode;
  browseUp: () => void;
  browseTo: (name: string) => void;
}): CommandPaletteGroup[] {
  const items: CommandPaletteActionItem[] = [];

  if (input.canBrowseUp) {
    items.push({
      kind: "action",
      value: "browse:up",
      searchTerms: [input.browseQuery, ".."],
      title: "..",
      icon: input.upIcon,
      keepOpen: true,
      run: async () => {
        input.browseUp();
      },
    });
  }

  for (const entry of input.browseEntries) {
    items.push({
      kind: "action",
      value: `browse:${entry.fullPath}`,
      searchTerms: [input.browseQuery, entry.fullPath, entry.name],
      title: entry.name,
      icon: input.directoryIcon,
      keepOpen: true,
      run: async () => {
        input.browseTo(entry.name);
      },
    });
  }

  return [{ value: "directories", label: "Directories", items }];
}

export function getCommandPaletteMode(input: {
  currentView: CommandPaletteView | null;
  isBrowsing: boolean;
}): CommandPaletteMode {
  if (input.currentView) {
    return input.isBrowsing ? "submenu-browse" : "submenu";
  }
  return input.isBrowsing ? "root-browse" : "root";
}

export function buildRootGroups(input: {
  actionItems: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  recentThreadItems: ReadonlyArray<CommandPaletteActionItem>;
}): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  if (input.actionItems.length > 0) {
    groups.push({ value: "actions", label: "Actions", items: input.actionItems });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: "recent-threads",
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

export function getCommandPaletteInputPlaceholder(mode: CommandPaletteMode): string {
  switch (mode) {
    case "root":
      return "Search commands, projects, and threads...";
    case "root-browse":
      return "Enter project path (e.g. ~/projects/my-app)";
    case "submenu":
      return "Search...";
    case "submenu-browse":
      return "Enter path (e.g. ~/projects/my-app)";
  }
}
