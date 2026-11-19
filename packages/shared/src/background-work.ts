/**
 * The rule shared by everything that closes a quiet session: agent-host's
 * idle reaper and the session extension's resolved-session closer.
 *
 * A session waiting on background work (a Monitor, a background shell or
 * subagent, a cron, a `/loop` wakeup) is not idle, however quiet its turns: a
 * close would kill that work and the session would never act on its result.
 * Agent-host reports the count as `backgroundTasks` in its session info.
 */

/**
 * Past this much quiet, background work no longer holds a session open.
 *
 * The count comes from the CLI's own registry, refreshed at every turn's end,
 * and finished work wakes the session (a new turn). A day with no turn at all
 * means the count is stale (an end that left no trace), not that a watch is
 * still useful, so the session is closed after all.
 */
export const BACKGROUND_HOLD_MAX_MS = 24 * 60 * 60 * 1000;

/** Whether a session's background work keeps it open after `quietMs` of quiet. */
export function heldByBackgroundWork(
  backgroundTasks: number | undefined,
  quietMs: number,
): boolean {
  return (backgroundTasks ?? 0) > 0 && quietMs < BACKGROUND_HOLD_MAX_MS;
}
