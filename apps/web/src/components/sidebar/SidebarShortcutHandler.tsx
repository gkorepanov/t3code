import { type ResolvedKeybindingsConfig, type ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useSidebar } from "../ui/sidebar";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function SidebarShortcutHandler() {
  const { toggleSidebar } = useSidebar();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const routeThreadId = useParams({
    strict: false,
    select: (params) => ("threadId" in params ? (params.threadId as ThreadId) : undefined),
  });
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "sidebar.toggle") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [keybindings, terminalOpen, toggleSidebar]);

  return null;
}
