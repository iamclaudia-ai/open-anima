/**
 * WorktreeSetupStrip — the strip above a chat whose worktree is still being made.
 *
 * `session.create_session` with a worktree answers at once and bootstraps the
 * worktree in the background (fetch, checkout, CodeGraph), which takes a minute
 * or two in a big repo. Until it's done the row carries `worktreeSetup`, and
 * this says so; a prompt sent meanwhile waits on the server. The strip goes
 * away by itself when `session.list_changed` brings the row back without it.
 */

import { useEffect, useState } from "react";
import type { SessionInfo } from "@anima/ui";
import { Loader2, OctagonAlert } from "lucide-react";

function elapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function WorktreeSetupStrip({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: SessionInfo[];
}) {
  const setup = sessions.find((s) => s.sessionId === sessionId)?.worktreeSetup;
  const running = setup?.state === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!setup) return null;

  if (setup.state === "failed") {
    return (
      <div
        role="alert"
        className="flex shrink-0 items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-800"
      >
        <OctagonAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          The <span className="font-mono">{setup.branch}</span> worktree couldn't be set up
          {setup.error ? (
            <span className="block truncate font-mono text-red-700" title={setup.error}>
              {setup.error}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span className="min-w-0">
        Setting up the <span className="font-mono">{setup.branch}</span> worktree…{" "}
        <span className="tabular-nums text-amber-700">{elapsed(setup.startedAt, now)}</span>
        <span className="text-amber-700">
          {" "}
          · You can send your first message now; it starts once the worktree is ready.
        </span>
      </span>
    </div>
  );
}
