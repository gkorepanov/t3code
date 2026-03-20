export const CHAT_FONT_SIZE_OPTIONS = ["sm", "md", "lg"] as const;
export type ChatFontSize = (typeof CHAT_FONT_SIZE_OPTIONS)[number];
export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = "md";

export const CHAT_FONT_SIZE_LABELS: Record<ChatFontSize, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
};

const CHAT_FONT_SIZE_METRICS = {
  sm: {
    fontSizePx: 13,
    lineHeightPx: 20,
    assistantAvgCharWidthPx: 6.7,
    userMonoAvgCharWidthPx: 7.8,
  },
  md: {
    fontSizePx: 14,
    lineHeightPx: 22,
    assistantAvgCharWidthPx: 7.2,
    userMonoAvgCharWidthPx: 8.4,
  },
  lg: {
    fontSizePx: 16,
    lineHeightPx: 24,
    assistantAvgCharWidthPx: 8.2,
    userMonoAvgCharWidthPx: 9.6,
  },
} as const satisfies Record<
  ChatFontSize,
  {
    fontSizePx: number;
    lineHeightPx: number;
    assistantAvgCharWidthPx: number;
    userMonoAvgCharWidthPx: number;
  }
>;

export function getChatFontSizeMetrics(fontSize: ChatFontSize) {
  return CHAT_FONT_SIZE_METRICS[fontSize];
}
