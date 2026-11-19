/**
 * Turn Summary Hook (an example to copy)
 *
 * When a session finishes a turn, emits one short line about it as
 * `hook.turn-summary.turn_completed`, for a UI, a script on the event bus, or
 * another hook to pick up.
 *
 * How it hears about the turn: the session extension emits
 * `session.status_changed` whenever a session's status actually moves, and a
 * turn that ends moves it to `completed`. That event has a fixed name (hook
 * files match exact names or a trailing `.*`; the per-session stream events,
 * `session.<id>.…`, can't be singled out that way) and its payload carries
 * the session's folder, so workspace hooks in `<cwd>/.anima/hooks` load too.
 *
 * Install: copy or symlink this file into ~/.anima/hooks (or a workspace's
 * .anima/hooks). The file name is the hook id.
 */

import type { HookDefinition } from "@anima/shared";

/** The fields of a `session.status_changed` payload this hook reads. */
interface StatusChange {
  sessionId?: string;
  cwd?: string | null;
  runtimeStatus?: string;
  previousRuntimeStatus?: string;
  title?: string | null;
  firstPrompt?: string | null;
  at?: string;
}

export interface TurnSummary {
  sessionId: string;
  cwd: string | null;
  /** "Fix the login redirect finished a turn (in /work/app)" */
  summary: string;
  at: string;
}

/** The session's name as the nav shows it: its title, else the start of its first prompt. */
function sessionName(change: StatusChange): string {
  const name = change.title?.trim() || change.firstPrompt?.trim() || "A session";
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}

/** The summary for a status change, or null when it isn't a turn finishing. */
export function summarizeTurn(change: StatusChange): TurnSummary | null {
  if (change.runtimeStatus !== "completed") return null;
  // A disposition-only change re-announces the same status; only a move counts.
  if (!change.previousRuntimeStatus || change.previousRuntimeStatus === "completed") return null;
  if (!change.sessionId) return null;
  const cwd = change.cwd ?? null;
  return {
    sessionId: change.sessionId,
    cwd,
    summary: `${sessionName(change)} finished a turn${cwd ? ` (in ${cwd})` : ""}`,
    at: change.at ?? new Date().toISOString(),
  };
}

export default {
  event: "session.status_changed",
  description: "Emit a one-line summary when a session finishes a turn",

  handler(ctx, payload) {
    const turn = summarizeTurn((payload ?? {}) as StatusChange);
    if (!turn) return;
    ctx.log.info(turn.summary);
    ctx.emit("turn_completed", turn);
  },
} satisfies HookDefinition;
