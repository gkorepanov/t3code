import { DEFAULT_CHAT_FONT_SIZE, getChatFontSizeMetrics, type ChatFontSize } from "../chatFontSize";
import { deriveDisplayedUserMessageState } from "../lib/terminalContext";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";

const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 56;
const ASSISTANT_BASE_HEIGHT_PX = 78;
const USER_BASE_HEIGHT_PX = 96;
const ATTACHMENTS_PER_ROW = 2;
// Attachment thumbnails render with `max-h-[220px]` plus ~8px row gap.
const USER_ATTACHMENT_ROW_HEIGHT_PX = 228;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;
const DEFAULT_CHAT_FONT_METRICS = getChatFontSizeMetrics(DEFAULT_CHAT_FONT_SIZE);

interface TimelineMessageHeightInput {
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string }>;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx: number | null;
  chatFontSize?: ChatFontSize;
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  // Avoid allocating via split for long logs; iterate once and count wrapped lines.
  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateFallbackCharsPerLine(
  fallbackCharsPerLine: number,
  defaultAvgCharWidthPx: number,
  avgCharWidthPx: number,
  minimumCharsPerLine: number,
) {
  return Math.max(
    minimumCharsPerLine,
    Math.floor((fallbackCharsPerLine * defaultAvgCharWidthPx) / avgCharWidthPx),
  );
}

function estimateCharsPerLineForUser(
  timelineWidthPx: number | null,
  avgCharWidthPx: number,
): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) {
    return estimateFallbackCharsPerLine(
      USER_CHARS_PER_LINE_FALLBACK,
      DEFAULT_CHAT_FONT_METRICS.userMonoAvgCharWidthPx,
      avgCharWidthPx,
      MIN_USER_CHARS_PER_LINE,
    );
  }
  const bubbleWidthPx = timelineWidthPx * USER_BUBBLE_WIDTH_RATIO;
  const textWidthPx = Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(MIN_USER_CHARS_PER_LINE, Math.floor(textWidthPx / avgCharWidthPx));
}

function estimateCharsPerLineForAssistant(
  timelineWidthPx: number | null,
  avgCharWidthPx: number,
): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) {
    return estimateFallbackCharsPerLine(
      ASSISTANT_CHARS_PER_LINE_FALLBACK,
      DEFAULT_CHAT_FONT_METRICS.assistantAvgCharWidthPx,
      avgCharWidthPx,
      MIN_ASSISTANT_CHARS_PER_LINE,
    );
  }
  const textWidthPx = Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(MIN_ASSISTANT_CHARS_PER_LINE, Math.floor(textWidthPx / avgCharWidthPx));
}

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  const chatFontMetrics = getChatFontSizeMetrics(layout.chatFontSize ?? DEFAULT_CHAT_FONT_SIZE);

  if (message.role === "assistant") {
    const charsPerLine = estimateCharsPerLineForAssistant(
      layout.timelineWidthPx,
      chatFontMetrics.assistantAvgCharWidthPx,
    );
    const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
    return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * chatFontMetrics.lineHeightPx;
  }

  if (message.role === "user") {
    const charsPerLine = estimateCharsPerLineForUser(
      layout.timelineWidthPx,
      chatFontMetrics.userMonoAvgCharWidthPx,
    );
    const displayedUserMessage = deriveDisplayedUserMessageState(message.text);
    const renderedText =
      displayedUserMessage.contexts.length > 0
        ? [
            buildInlineTerminalContextText(displayedUserMessage.contexts),
            displayedUserMessage.visibleText,
          ]
            .filter((part) => part.length > 0)
            .join(" ")
        : displayedUserMessage.visibleText;
    const estimatedLines = estimateWrappedLineCount(renderedText, charsPerLine);
    const attachmentCount = message.attachments?.length ?? 0;
    const attachmentRows = Math.ceil(attachmentCount / ATTACHMENTS_PER_ROW);
    const attachmentHeight = attachmentRows * USER_ATTACHMENT_ROW_HEIGHT_PX;
    return USER_BASE_HEIGHT_PX + estimatedLines * chatFontMetrics.lineHeightPx + attachmentHeight;
  }

  // `system` messages are not rendered in the chat timeline, but keep a stable
  // explicit branch in case they are present in timeline data.
  const charsPerLine = estimateCharsPerLineForAssistant(
    layout.timelineWidthPx,
    chatFontMetrics.assistantAvgCharWidthPx,
  );
  const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
  return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * chatFontMetrics.lineHeightPx;
}
