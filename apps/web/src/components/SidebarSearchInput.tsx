import { SearchIcon } from "lucide-react";

import { SidebarInput } from "./ui/sidebar";

export default function SidebarSearchInput({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="mb-2 px-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/45" />
        <SidebarInput
          aria-label="Search dialogs"
          autoComplete="off"
          className="h-8 bg-secondary pl-7 text-xs placeholder:text-muted-foreground/45"
          data-testid="sidebar-search-input"
          placeholder="Search dialogs..."
          spellCheck={false}
          type="search"
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
        />
      </div>
    </div>
  );
}
