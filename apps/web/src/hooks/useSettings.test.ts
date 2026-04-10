import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates browser link prefix and confirmation settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      browserFileLinkPrefix: "vscode://vscode-remote/ssh-remote+wf-gk/",
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });
});
