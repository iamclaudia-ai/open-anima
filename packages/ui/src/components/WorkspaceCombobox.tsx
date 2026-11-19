import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { WorkspaceInfo } from "../hooks/useChatGateway";
import { matchWorkspaces } from "./newSessionDefaults";

interface WorkspaceComboboxProps {
  workspaces: WorkspaceInfo[];
  selectedId: string;
  onSelect: (workspaceId: string) => void;
  disabled?: boolean;
  className: string;
}

/**
 * A workspace picker you type into. Shows the chosen workspace's name; focus
 * it and type to filter, then Enter, Tab or a click picks. Escape, or leaving
 * without picking, keeps the previous choice. Enter with the list closed and
 * Escape with it closed fall through to the dialog (submit, close).
 */
export function WorkspaceCombobox({
  workspaces,
  selectedId,
  onSelect,
  disabled,
  className,
}: WorkspaceComboboxProps) {
  const listId = useId();
  const selected = workspaces.find((w) => w.id === selectedId) ?? null;
  // What's typed while picking; null shows the chosen workspace's name.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = matchWorkspaces(workspaces, query ?? "");

  const openList = () => {
    // Untyped, the whole list shows, starting at the current choice.
    const at = query
      ? 0
      : Math.max(
          0,
          matches.findIndex((w) => w.id === selectedId),
        );
    setHighlight(at);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  const pick = (workspace: WorkspaceInfo | undefined) => {
    if (workspace) onSelect(workspace.id);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((i) => Math.min(Math.max(i + step, 0), Math.max(matches.length - 1, 0)));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      e.stopPropagation();
      pick(matches[highlight]);
    } else if (e.key === "Tab" && open && query) {
      pick(matches[highlight]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const activeId = open && matches[highlight] ? `${listId}-${highlight}` : undefined;

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label="Workspace"
        value={query ?? selected?.name ?? ""}
        placeholder="Type to find a workspace"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={`${className} pr-8`}
        onFocus={(e) => {
          e.target.select();
          openList();
        }}
        // Still focused after a pick, so focus won't fire again: select here
        // too, or typing would append to the name instead of searching.
        onClick={(e) => {
          if (open) return;
          e.currentTarget.select();
          openList();
        }}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No matching workspace</div>
          ) : (
            matches.map((workspace, index) => (
              <div
                key={workspace.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlight}
                tabIndex={-1}
                ref={
                  index === highlight ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined
                }
                // mousedown, not click: picking must happen before the input blurs.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(workspace);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={`cursor-pointer px-3 py-1.5 ${index === highlight ? "bg-blue-50" : ""}`}
              >
                <div
                  className={`truncate text-sm ${workspace.id === selectedId ? "font-semibold text-blue-700" : "text-gray-900"}`}
                >
                  {workspace.name}
                </div>
                <div className="truncate font-mono text-xs text-gray-400">
                  {workspace.cwdDisplay}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
