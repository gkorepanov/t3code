import type { ModelCapabilities } from "@t3tools/contracts";

export function createCodexModelCapabilities(): ModelCapabilities {
  return {
    reasoningEffortLevels: [
      { value: "xhigh", label: "Extra High", isDefault: true },
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ],
    supportsFastMode: true,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}
