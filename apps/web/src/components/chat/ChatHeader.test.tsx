import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../GitActionsControl", () => ({
  default: () => <div data-slot="git-actions" />,
}));

import { ChatHeader } from "./ChatHeader";
import { SidebarProvider } from "../ui/sidebar";

beforeAll(() => {
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
  });
});

describe("ChatHeader", () => {
  it("renders reload after diff and hides project badge/open-in controls on mobile", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          activeThreadId={ThreadId.makeUnsafe("thread-1")}
          activeThreadTitle="Thread 1"
          activeProjectName="Project 1"
          isGitRepo
          openInCwd="/tmp/project-1"
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={["file-manager"]}
          terminalAvailable
          terminalOpen={false}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          gitCwd={null}
          diffOpen={false}
          onRunProjectScript={() => {}}
          onAddProjectScript={async () => {}}
          onUpdateProjectScript={async () => {}}
          onDeleteProjectScript={async () => {}}
          onToggleTerminal={() => {}}
          onToggleDiff={() => {}}
          onReload={() => {}}
          isReloading={false}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain("hidden min-w-0 shrink truncate md:inline-flex");
    expect(markup).toContain("hidden md:block");
    expect(markup).toContain('data-slot="sidebar-trigger"');
    expect(markup).not.toContain("md:hidden");
    expect(markup).toContain('aria-label="Toggle diff panel"');
    expect(markup).toContain('aria-label="Reload chat"');
    expect(markup.indexOf('aria-label="Toggle diff panel"')).toBeLessThan(
      markup.indexOf('aria-label="Reload chat"'),
    );
  });
});
