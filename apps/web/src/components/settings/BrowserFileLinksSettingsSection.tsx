import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";

export function BrowserFileLinksSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Links
        </h2>
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">Browser file links</h3>
              <p className="text-xs text-muted-foreground">
                Rewrite plain clicks on markdown file links to a custom browser URI.
              </p>
            </div>
            <label htmlFor="browser-file-link-prefix" className="block space-y-2">
              <span className="text-xs font-medium text-foreground">Browser file-link prefix</span>
              <Input
                id="browser-file-link-prefix"
                value={settings.browserFileLinkPrefix}
                onChange={(event) => updateSettings({ browserFileLinkPrefix: event.target.value })}
                placeholder="vscode://vscode-remote/ssh-remote+wf-gk/"
                spellCheck={false}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Leave empty to keep normal browser navigation. Without an explicit line suffix, plain
              clicks append <code>:0</code>.
            </p>
            {settings.browserFileLinkPrefix !== DEFAULT_UNIFIED_SETTINGS.browserFileLinkPrefix ? (
              <p className="text-xs text-muted-foreground">
                Current prefix: <code className="break-all">{settings.browserFileLinkPrefix}</code>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
