import { afterEach, describe, expect, it } from "vitest";
import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import {
  resolveSidebarShortcutCommand,
  type SidebarShortcutEventLike,
} from "./sidebarShortcutBehavior";

class MockHTMLElement {
  addEventListener() {}

  dispatchEvent(): boolean {
    return true;
  }

  removeEventListener() {}
}

const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

function event(overrides: Partial<SidebarShortcutEventLike> = {}): SidebarShortcutEventLike {
  return {
    key: "b",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    repeat: false,
    target: null,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function compile(
  bindings: ReadonlyArray<{ command: KeybindingCommand; shortcut: KeybindingShortcut }>,
): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
  }));
}

const SIDEBAR_BINDINGS = compile([{ shortcut: modShortcut("b"), command: "sidebar.toggle" }]);

describe("resolveSidebarShortcutCommand", () => {
  it("resolves Cmd/Ctrl+B outside editable targets", () => {
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;

    expect(
      resolveSidebarShortcutCommand(
        event({ metaKey: true, target: new MockHTMLElement() }),
        SIDEBAR_BINDINGS,
        { platform: "MacIntel" },
      ),
    ).toBe("sidebar.toggle");
  });

  it("resolves Cmd/Ctrl+B from editable targets too", () => {
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;

    expect(
      resolveSidebarShortcutCommand(
        event({ metaKey: true, target: new MockHTMLElement() }),
        SIDEBAR_BINDINGS,
        { platform: "MacIntel" },
      ),
    ).toBe("sidebar.toggle");
  });

  it("ignores repeated or prevented events", () => {
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;

    expect(
      resolveSidebarShortcutCommand(
        event({ metaKey: true, repeat: true, target: new MockHTMLElement() }),
        SIDEBAR_BINDINGS,
        { platform: "MacIntel" },
      ),
    ).toBeNull();
    expect(
      resolveSidebarShortcutCommand(
        event({ metaKey: true, defaultPrevented: true, target: new MockHTMLElement() }),
        SIDEBAR_BINDINGS,
        { platform: "MacIntel" },
      ),
    ).toBeNull();
  });
});
