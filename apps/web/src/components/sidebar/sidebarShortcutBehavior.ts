import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

interface SidebarShortcutContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
}

interface SidebarShortcutOptions {
  platform?: string;
  context?: Partial<SidebarShortcutContext>;
}

export interface SidebarShortcutEventLike extends ShortcutEventLike {
  defaultPrevented: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

export function resolveSidebarShortcutCommand(
  event: SidebarShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: SidebarShortcutOptions,
): "sidebar.toggle" | null {
  if (event.defaultPrevented || event.repeat) {
    return null;
  }

  const command = resolveShortcutCommand(event, keybindings, options);
  return command === "sidebar.toggle" ? command : null;
}
