import { describe, expect, it } from "vitest";

import {
  shouldAllowDesktopPermissionRequest,
  shouldAllowMediaPermissionRequest,
} from "./mediaPermissions.js";

describe("desktop permission requests", () => {
  it("allows sanitized clipboard writes for renderer copy actions", () => {
    expect(shouldAllowDesktopPermissionRequest("clipboard-sanitized-write", {})).toBe(true);
  });

  it("does not allow clipboard reads", () => {
    expect(shouldAllowDesktopPermissionRequest("clipboard-read", {})).toBe(false);
  });

  it("keeps media permission limited to audio", () => {
    expect(shouldAllowDesktopPermissionRequest("media", { mediaTypes: ["audio"] })).toBe(true);
    expect(shouldAllowDesktopPermissionRequest("media", { mediaTypes: ["video"] })).toBe(false);
  });
});

describe("media permission requests", () => {
  it("allows legacy Electron media requests without media type details", () => {
    expect(shouldAllowMediaPermissionRequest({})).toBe(true);
  });
});
