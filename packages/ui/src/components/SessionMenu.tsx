/**
 * The per-session ⋯ menu: mark done, pin, copy the tmux command, rename, and
 * set the human status.
 *
 * One component for every place a session can be acted on: the nav's tree
 * row, its ACTIVE queue row, and the chat header. They are the same session
 * seen from three angles, and an action available in one place but not the
 * others is the kind of inconsistency you only notice while hunting for the
 * button that was there a second ago.
 */

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  BellOff,
  Check,
  CircleCheck,
  Eye,
  MoreHorizontal,
  OctagonAlert,
  Pencil,
  Pin,
  PinOff,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SessionDisposition } from "../hooks/useChatGateway";
import { useExtensionConfig } from "../contexts/ExtensionConfigContext";

/**
 * How each disposition reads. `open` has no mark — it's the default, and
 * marking every untouched session "Open" would be noise.
 *
 * An icon rather than a worded chip. The label was costing a row's whole
 * second line on the states that occur most, and the pane is a scan surface:
 * you read down a column of marks and stop at the one that isn't like the
 * others. Six distinct glyphs do that in a fraction of the width. The words
 * aren't gone — they're the tooltip and the accessible name, which is where a
 * label belongs once its shape is recognisable.
 */
export const DISPOSITION_PRESENTATION: Partial<
  Record<SessionDisposition, { label: string; className: string; Icon: LucideIcon }>
> = {
  needs_review: { label: "Needs review", className: "text-blue-600", Icon: Eye },
  blocked: { label: "Blocked", className: "text-red-600", Icon: OctagonAlert },
  snoozed: { label: "Snoozed", className: "text-gray-400", Icon: BellOff },
  resolved: { label: "Resolved", className: "text-green-600", Icon: CircleCheck },
  archived: { label: "Archived", className: "text-gray-400", Icon: Archive },
};

/** The order dispositions appear in the menu. */
const DISPOSITION_MENU: SessionDisposition[] = [
  "open",
  "needs_review",
  "blocked",
  "snoozed",
  "resolved",
  "archived",
];

const DISPOSITION_MENU_LABELS: Record<SessionDisposition, string> = {
  open: "Open",
  needs_review: "Needs review",
  blocked: "Blocked",
  snoozed: "Snoozed",
  resolved: "Resolved",
  archived: "Archived",
};

/**
 * The command that attaches a terminal to a session's CLI pane:
 * `<prefix>-claude-<id>`, the prefix being this instance's
 * `agentHost.tmuxPrefix` (default "anima").
 */
export function tmuxAttachCommand(sessionId: string, tmuxPrefix = "anima"): string {
  return `tmux attach -t ${tmuxPrefix}-claude-${sessionId}`;
}

// ── Click-outside hook ──────────────────────────────────────────

export function useClickOutside<T extends HTMLElement>(
  enabled: boolean,
  onOutside: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [enabled, onOutside]);
  return ref;
}

/** Renaming inside the menu itself, for hosts with no row to turn into a field. */
export interface SessionMenuRenameField {
  /** The explicit title, or "" when the session has none. */
  initial: string;
  /** The derived name, shown when the field is empty: what clearing gives back. */
  placeholder: string;
  onCommit: (title: string | null) => void;
}

export interface SessionMenuProps {
  sessionId: string;
  disposition?: SessionDisposition;
  /** Shown above the items: which session this is. The chat header has no row to say it. */
  heading?: string;
  /** Present where pinning means something: it orders the ACTIVE pane. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Rename by turning the host's row into a field (the nav rows). */
  onRename?: () => void;
  /** Rename inside the menu (the chat header). Wins over `onRename`. */
  renameField?: SessionMenuRenameField;
  onSetDisposition?: (disposition: SessionDisposition) => void;
  /** The one-tap version of "status → resolved". */
  onAcknowledge?: () => void;
  /**
   * `row`: a small glyph that overlays a nav row. `header`: sized and tinted
   * like the other buttons in the app header.
   */
  variant?: "row" | "header";
  /** Which edge of the trigger the dropdown lines up with. */
  align?: "left" | "right";
}

const ITEM_CLASS =
  "flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 pointer-coarse:py-2.5 pointer-coarse:text-sm";

export function SessionMenu({
  sessionId,
  disposition,
  heading,
  pinned,
  onTogglePin,
  onRename,
  renameField,
  onSetDisposition,
  onAcknowledge,
  variant = "row",
  align = "right",
}: SessionMenuProps) {
  const { tmuxPrefix } = useExtensionConfig<{ tmuxPrefix?: string }>("gateway");
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const close = (): void => {
    setMenuOpen(false);
    setRenaming(false);
  };
  // Not while renaming: a click elsewhere then blurs the field, which commits
  // the typing and closes the menu. Closing first would throw the typing away.
  const menuRef = useClickOutside<HTMLSpanElement>(menuOpen && !renaming, close);

  // Escape closes, as any menu should. Not while renaming: the field owns
  // Escape then, and uses it to cancel the rename.
  useEffect(() => {
    if (!menuOpen || renaming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, renaming]);

  const handleCopyAttach = async () => {
    await copyText(tmuxAttachCommand(sessionId, tmuxPrefix));
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
      setMenuOpen(false);
    }, 900);
  };

  const canRename = Boolean(renameField || onRename);
  const startRename = (): void => {
    if (renameField) {
      setRenaming(true);
      return;
    }
    setMenuOpen(false);
    onRename?.();
  };

  const trigger =
    variant === "header" ? (
      <button
        type="button"
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? close() : setMenuOpen(true))}
        className={`rounded-md p-1.5 text-gray-600 transition-colors hover:bg-white/40 hover:text-gray-800 ${
          menuOpen ? "bg-white/50 text-gray-800" : ""
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    ) : (
      <button
        type="button"
        title="Session actions"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => (menuOpen ? close() : setMenuOpen(true))}
        // A finger needs more than the 18px a mouse is happy with.
        className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 pointer-coarse:p-1"
      >
        <MoreHorizontal className="size-3.5 pointer-coarse:size-4" />
      </button>
    );

  return (
    <span className="relative" ref={menuRef}>
      {trigger}
      {menuOpen && (
        <span
          role="menu"
          className={`absolute z-50 flex flex-col rounded-md border border-gray-200 bg-white py-1 text-left shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          } ${
            // On a phone the header's ⋯ sits mid-screen, where a 240px menu
            // anchored to it would run off one edge. There it spans the
            // width under the header instead.
            variant === "header"
              ? "top-9 w-60 max-sm:fixed max-sm:inset-x-4 max-sm:top-12 max-sm:w-auto"
              : "top-6 w-44 pointer-coarse:w-52"
          }`}
        >
          {heading && !renaming && (
            <span className="truncate border-b border-gray-100 px-3 pb-1.5 pt-1 text-xs font-medium text-gray-800">
              {heading}
            </span>
          )}
          {renaming && renameField ? (
            <span className="flex flex-col gap-1 px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Rename</span>
              <SessionTitleInput
                initial={renameField.initial}
                placeholder={renameField.placeholder}
                onCancel={() => setRenaming(false)}
                onCommit={(value) => {
                  close();
                  renameField.onCommit(value);
                }}
              />
            </span>
          ) : (
            <>
              {onAcknowledge && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onAcknowledge();
                  }}
                  className={ITEM_CLASS}
                >
                  <Check className="size-3" />
                  Mark done
                </button>
              )}
              {onTogglePin && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onTogglePin();
                  }}
                  className={ITEM_CLASS}
                >
                  {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                  {pinned ? "Unpin" : "Pin"}
                </button>
              )}
              {canRename && (
                <button type="button" role="menuitem" onClick={startRename} className={ITEM_CLASS}>
                  <Pencil className="size-3" />
                  Rename
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={handleCopyAttach}
                className={ITEM_CLASS}
              >
                {copied ? <Check className="size-3" /> : <Terminal className="size-3" />}
                {copied ? "Copied" : "Copy tmux command"}
              </button>
              {onSetDisposition && (
                <>
                  <span className="my-1 border-t border-gray-100" />
                  <span className="px-3 pb-1 text-[10px] uppercase tracking-wide text-gray-400">
                    Status
                  </span>
                  {DISPOSITION_MENU.map((option) => {
                    const current = (disposition ?? "open") === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        onClick={() => {
                          close();
                          if (!current) onSetDisposition(option);
                        }}
                        className={`${ITEM_CLASS} justify-between ${
                          current ? "font-medium text-gray-900" : ""
                        }`}
                      >
                        {/* The same glyph the row shows, next to the word it means.
                            A tooltip is only discoverable once you hover the right
                            thing; this is where the vocabulary is actually learnt. */}
                        <span className="flex items-center gap-2">
                          <DispositionMenuIcon disposition={option} />
                          {DISPOSITION_MENU_LABELS[option]}
                        </span>
                        {current && <Check className="size-3" />}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** The menu's leading glyph — blank for `open`, which has no mark of its own. */
function DispositionMenuIcon({ disposition }: { disposition: SessionDisposition }) {
  const presentation = DISPOSITION_PRESENTATION[disposition];
  if (!presentation) return <span className="size-3.5" aria-hidden="true" />;
  const { Icon } = presentation;
  return <Icon className={`size-3.5 ${presentation.className}`} aria-hidden="true" />;
}

/**
 * Clipboard write with a fallback.
 *
 * `navigator.clipboard` is unavailable outside a secure context, and Anima is
 * often reached over plain HTTP (a LAN or VPN address) — so the modern API alone
 * would silently do nothing on exactly the devices this button is for.
 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(field);
  }
}

/**
 * Inline rename field.
 *
 * Enter commits, Escape cancels, blur commits — an accidental click elsewhere
 * shouldn't throw away typing. Submitting an empty value clears the rename,
 * which is why the placeholder shows the derived title: it's a preview of
 * exactly what you get back.
 */
export function SessionTitleInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (title: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const committed = useRef(false);

  const commit = (): void => {
    if (committed.current) return;
    committed.current = true;
    const trimmed = value.trim();
    if (trimmed === initial.trim()) {
      onCancel();
      return;
    }
    onCommit(trimmed ? trimmed : null);
  };

  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      // 16px on a phone: iOS Safari zooms the page into any smaller field.
      className="w-full rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm text-gray-900 outline-none focus:border-gray-500 pointer-coarse:text-base"
    />
  );
}
