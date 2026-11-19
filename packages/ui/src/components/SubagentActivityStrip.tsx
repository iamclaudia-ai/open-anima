import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import type { SubagentInfo } from "../hooks/useChatGateway";
import { Link } from "../router";

interface SubagentActivityStripProps {
  subagents: SubagentInfo[];
  /**
   * Where a subagent's own session lives, for clients with routes (the web).
   * Without it the strip shows the preview only.
   */
  subagentHref?: (subagentId: string) => string;
}

function shortSubagentId(subagentId: string): string {
  return subagentId.length > 16 ? `${subagentId.slice(0, 16)}...` : subagentId;
}

function formatAgo(value?: string): string {
  if (!value) return "now";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return "now";
  const elapsedSec = Math.floor(elapsedMs / 1_000);
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const elapsedHr = Math.floor(elapsedMin / 60);
  if (elapsedHr < 24) return `${elapsedHr}h ago`;
  const elapsedDay = Math.floor(elapsedHr / 24);
  return `${elapsedDay}d ago`;
}

function statusLabel(status: SubagentInfo["status"]): string {
  if (status === "running") return "Busy";
  if (status === "completed") return "Done";
  if (status === "interrupted") return "Stopped";
  return "Failed";
}

function statusClasses(status: SubagentInfo["status"]): string {
  if (status === "running") {
    return "bg-amber-400";
  }
  if (status === "failed") {
    return "bg-rose-400";
  }
  return "bg-emerald-400";
}

/** "2 running · 1 failed · 5 done": the counts that matter, busiest first. */
export function subagentSummary(subagents: SubagentInfo[]): string {
  const count = (status: SubagentInfo["status"]) =>
    subagents.filter((s) => s.status === status).length;
  const parts = [
    [count("running"), "running"],
    [count("failed"), "failed"],
    [count("interrupted"), "stopped"],
    [count("completed"), "done"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

/**
 * The parent session's subagents, behind one pill.
 *
 * Collapsed by default: a session that delegates a lot can have dozens, and a
 * list of cards that size takes over the chat. The pill sits at the right and
 * carries the counts, with a pulsing dot while any are busy; opening it lists
 * every subagent full width (newest work first, as the server sends them),
 * each expandable, in a scrolling panel. Light lavender, like the rest of the
 * chat: these are instances of the agent, after all.
 */
export function SubagentActivityStrip({ subagents, subagentHref }: SubagentActivityStripProps) {
  const [open, setOpen] = useState(false);
  const [expandedSubagentId, setExpandedSubagentId] = useState<string | null>(null);

  if (subagents.length === 0) return null;
  const anyRunning = subagents.some((s) => s.status === "running");

  const pill = (
    <button
      type="button"
      onClick={() => setOpen((prev) => !prev)}
      aria-expanded={open}
      className="ml-auto flex max-w-full items-center gap-1.5 rounded-full border border-purple-200/70 bg-purple-50/90 px-3 py-1 text-left text-[11px] text-purple-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-purple-100/90"
    >
      <Bot className="size-3.5 shrink-0 text-purple-400" />
      <span className="shrink-0 font-medium">
        {subagents.length === 1 ? "1 subagent" : `${subagents.length} subagents`}
      </span>
      {anyRunning && <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-400" />}
      <span className="truncate text-purple-500">{subagentSummary(subagents)}</span>
      {open ? (
        <ChevronUp className="size-3.5 shrink-0 text-purple-400" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-purple-400" />
      )}
    </button>
  );

  if (!open) return <div className="flex px-3 py-1">{pill}</div>;

  return (
    <div className="border-t border-purple-100 bg-gradient-to-b from-purple-50/80 to-white/60 px-3 py-1.5">
      <div className="flex">{pill}</div>
      <div className="mt-1.5 max-h-72 space-y-2 overflow-y-auto pb-1">
        {subagents.map((subagent) => {
          const expanded = expandedSubagentId === subagent.subagentId;
          const preview =
            subagent.previewText || subagent.error || subagent.prompt || "Waiting for output...";
          return (
            <div
              key={subagent.subagentId}
              className="overflow-hidden rounded-xl border border-purple-100 bg-white/90 shadow-sm"
            >
              <button
                type="button"
                className="w-full px-3 py-2 text-left transition-colors hover:bg-purple-50/60"
                onClick={() =>
                  setExpandedSubagentId((prev) =>
                    prev === subagent.subagentId ? null : subagent.subagentId,
                  )
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${statusClasses(subagent.status)} ${
                      subagent.status === "running" ? "animate-pulse" : ""
                    }`}
                  />
                  <span className="text-xs font-medium text-gray-800">
                    {shortSubagentId(subagent.subagentId)}
                  </span>
                  <span className="text-xs text-gray-500">{subagent.agent}</span>
                  <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-purple-700">
                    {subagent.purpose}
                  </span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500">
                    {statusLabel(subagent.status)}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {formatAgo(subagent.updatedAt || subagent.startedAt)}
                  </span>
                  {expanded ? (
                    <ChevronUp className="size-3.5 text-purple-300" />
                  ) : (
                    <ChevronDown className="size-3.5 text-purple-300" />
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-gray-600">{preview}</p>
              </button>
              {expanded && (
                <div className="border-t border-purple-100 bg-purple-50/40 px-3 py-2 text-xs text-gray-700">
                  {subagent.prompt && (
                    <p className="mb-2 line-clamp-3 text-gray-500">
                      Prompt: <span className="text-gray-700">{subagent.prompt}</span>
                    </p>
                  )}
                  {subagent.previewText && (
                    <p className="mb-2 whitespace-pre-wrap break-words text-gray-800">
                      {subagent.previewText}
                    </p>
                  )}
                  {subagent.cwd && (
                    <p className="truncate text-gray-400">
                      CWD: <span className="text-gray-600">{subagent.cwd}</span>
                    </p>
                  )}
                  {subagentHref && (
                    <Link
                      to={subagentHref(subagent.subagentId)}
                      className="mt-2 inline-flex items-center gap-1 text-purple-600 hover:underline"
                    >
                      Open session
                      <ExternalLink className="size-3" />
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
