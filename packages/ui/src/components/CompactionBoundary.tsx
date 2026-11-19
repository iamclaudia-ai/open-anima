/**
 * CompactionBoundary — visual marker rendered in message history
 * when Claude Code performed context compaction.
 *
 * Shows a horizontal divider with compaction metadata (trigger, token count). When the
 * history carries the summary Claude Code wrote, the badge folds it open and closed: it's
 * collapsed by default, so coming back to a compacted session lands on the conversation,
 * not a screen-long summary.
 */

import { useState } from "react";
import { ChevronDown, Scissors } from "lucide-react";
import { MessageContent } from "./MessageContent";

interface CompactionBoundaryProps {
  trigger: "manual" | "auto";
  preTokens: number;
  /** A number from live events, an ISO string from history. */
  timestamp?: number | string;
  /** The notes the compaction carried forward. */
  summary?: string;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return tokens.toLocaleString();
}

export default function CompactionBoundary({
  trigger,
  preTokens,
  timestamp,
  summary,
}: CompactionBoundaryProps) {
  const [open, setOpen] = useState(false);
  const label = trigger === "auto" ? "Auto-compacted" : "Manually compacted";
  const time = timestamp === undefined ? null : new Date(timestamp);
  const timeStr =
    time && !Number.isNaN(time.getTime())
      ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;

  const badge = (
    <>
      <Scissors className="size-3 text-purple-400" />
      <span className="text-[11px] font-medium text-purple-600">{label}</span>
      {preTokens > 0 && (
        <span className="text-[10px] text-purple-400">{formatTokens(preTokens)} tokens</span>
      )}
      {timeStr && <span className="text-[10px] text-purple-300">{timeStr}</span>}
    </>
  );
  const badgeClass =
    "flex items-center gap-1.5 px-3 py-1 mx-3 rounded-full border border-purple-200/60 bg-purple-50/80 backdrop-blur-sm";

  return (
    <div className="my-4 px-4">
      <div className="relative flex items-center justify-center">
        {/* Gradient line left */}
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-purple-300/60 to-purple-300/60" />

        {/* Center badge: a toggle for the notes when there are any */}
        {summary ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={open ? "Hide the compaction notes" : "Show the compaction notes"}
            className={`${badgeClass} hover:bg-purple-100/80`}
          >
            {badge}
            <span className="text-[10px] text-purple-500">· notes</span>
            <ChevronDown
              className={`size-3 text-purple-400 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        ) : (
          <div className={badgeClass}>{badge}</div>
        )}

        {/* Gradient line right */}
        <div className="flex-1 h-px bg-gradient-to-l from-transparent via-purple-300/60 to-purple-300/60" />
      </div>
      {summary && open && (
        <div className="mx-auto mt-3 max-h-[60vh] max-w-3xl overflow-y-auto rounded-xl border border-purple-200/60 bg-purple-50/40 px-4 py-3 text-sm">
          <MessageContent content={summary} type="assistant" />
        </div>
      )}
    </div>
  );
}
