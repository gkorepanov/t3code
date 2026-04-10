import type { ProviderKind } from "@t3tools/contracts";

export const DEFAULT_FAST_MODE_BY_PROVIDER = {
  codex: true,
  claudeAgent: false,
} as const satisfies Record<ProviderKind, boolean>;
