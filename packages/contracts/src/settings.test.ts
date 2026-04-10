import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "./settings";

describe("DEFAULT_CLIENT_SETTINGS", () => {
  it("includes client-only defaults", () => {
    expect(DEFAULT_CLIENT_SETTINGS.browserFileLinkPrefix).toBe("");
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });
});
