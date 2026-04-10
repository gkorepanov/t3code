import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";

export function ComposerSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Composer
        </h2>
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-sm font-medium text-foreground">Cmd/Ctrl+Enter to send</h3>
              <p className="text-xs text-muted-foreground">
                When enabled, Enter inserts a new line and only Cmd/Ctrl+Enter sends the message.
              </p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
              <Switch
                checked={settings.requireMetaEnterToSend}
                onCheckedChange={(checked) =>
                  updateSettings({ requireMetaEnterToSend: Boolean(checked) })
                }
                aria-label="Send messages only with Cmd/Ctrl+Enter"
              />
            </div>
          </div>
          {settings.requireMetaEnterToSend !== DEFAULT_UNIFIED_SETTINGS.requireMetaEnterToSend ? (
            <p className="mt-3 text-xs text-muted-foreground">Changed from the default send key.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
