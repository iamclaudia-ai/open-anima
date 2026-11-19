/**
 * Close the runtimes of sessions whose work is done.
 *
 * A resolved session (the user marked it done, or it handed off its work) keeps
 * its `claude` process, MCP servers and Bash wrapper alive until agent-host's
 * idle reaper notices hours later, at half a gigabyte or more apiece. A busy
 * day of handoffs stacked a dozen of them. Resolving is the signal that the
 * session is finished, so the live sweep closes it once it is at rest.
 *
 * Closing is not archiving: the row, transcript and disposition stay as they
 * are, exactly as when the idle reaper closes a session. A prompt sent to it
 * later resumes it, as with any closed session.
 *
 * "At rest" means no turn in flight, no background work, and quiet for a grace
 * period. The grace matters for a handoff: the caller is resolved while its own
 * turn is still running the handoff command, and should be left to finish its
 * reply. Background work (a Monitor watching CI, a background shell or
 * subagent, a cron, a `/loop` wakeup) would die with the runtime, so a resolved
 * session waiting on some stays open; when the work ends it wakes the session
 * for a turn, and the grace runs from there.
 */

import { heldByBackgroundWork } from "@anima/shared";
import type { AgentHostSessionInfo } from "../session-types";
import type { RuntimeStatus, SessionDisposition, StoredSession } from "../session-store";

/** A resolved session at rest this long is closed. */
export const RESOLVED_CLOSE_GRACE_MS = 5 * 60 * 1000;

const FINISHED: readonly SessionDisposition[] = ["resolved", "archived"];
const MID_TURN: readonly RuntimeStatus[] = ["running", "awaiting_input", "awaiting_approval"];

/** The live sessions that are finished and at rest, so may be closed now. */
export function resolvedSessionsToClose(
  live: readonly AgentHostSessionInfo[],
  getStored: (
    sessionId: string,
  ) => Pick<StoredSession, "disposition" | "runtimeStatus" | "lastActivity"> | null,
  nowMs: number,
  graceMs: number = RESOLVED_CLOSE_GRACE_MS,
): string[] {
  return live
    .filter((session) => {
      if (session.turnActive === true) return false;
      const stored = getStored(session.id);
      if (!stored || !FINISHED.includes(stored.disposition)) return false;
      // A provider that can't report turn state: trust the lifecycle's row.
      if (session.turnActive === undefined && MID_TURN.includes(stored.runtimeStatus)) {
        return false;
      }
      const lastActivity = Date.parse(stored.lastActivity);
      if (!Number.isFinite(lastActivity)) return false;
      const quietMs = nowMs - lastActivity;
      return quietMs >= graceMs && !heldByBackgroundWork(session.backgroundTasks, quietMs);
    })
    .map((session) => session.id);
}
