import { scopeThreadRef } from "@t3tools/client-runtime";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { isTerminalFocused } from "../../lib/terminalFocus";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useServerKeybindings } from "../../rpc/serverState";
import { useSidebar } from "../ui/sidebar";
import { resolveSidebarShortcutCommand } from "./sidebarShortcutBehavior";

export function SidebarShortcutHandler() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) =>
      typeof params.environmentId === "string" && typeof params.threadId === "string"
        ? scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId)
        : undefined,
  });
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const command = resolveSidebarShortcutCommand(event, keybindings, {
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

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [keybindings, terminalOpen, toggleSidebar]);

  return null;
}
