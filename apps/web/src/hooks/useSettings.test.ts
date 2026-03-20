import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
        chatFontSize: "lg",
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
      chatFontSize: "lg",
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });
});
