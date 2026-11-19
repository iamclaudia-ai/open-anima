/**
 * Background work a CLI session is waiting on between turns: a Monitor,
 * a `run_in_background` Bash command, a background Agent, a cron or a `/loop`
 * wakeup. Closing the session kills all of it, so the resolved-session closer
 * and the idle reaper must leave such a session alone.
 *
 * Two sources, measured on Claude Code 2.1.325:
 *
 * 1. **The Stop hook's input**, the CLI's own registry: `background_tasks`
 *    (running/pending background tasks of every kind) and `session_crons`
 *    (CronCreate jobs and `/loop` wakeups). Our hook (`bin/stop-hook.ts`) saves
 *    it as a snapshot file per session. It is exact, but only as of a turn's
 *    end: Stop doesn't fire on an interrupted turn, and work started in that
 *    turn survives the interrupt.
 * 2. **The transcript**, between snapshots: a start leaves an id in its tool
 *    result, an end leaves a `<task-notification>` with a terminal status (or a
 *    TaskStop result, or a scheduled task firing). This also covers sessions
 *    launched before the hook existed: a running `claude` never re-reads the
 *    hooks in its `--settings` file.
 *
 * The ledger is the latest snapshot plus the transcript changes written after it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A started background item, as the transcript shows it. */
export interface BackgroundStart {
  id: string;
  /** A recurring cron: firing doesn't end it. */
  recurring?: boolean;
}

/** What one transcript entry changes. Empty arrays when nothing. */
export interface BackgroundChanges {
  started: BackgroundStart[];
  ended: string[];
}

/** The Stop hook's view of a session, saved per session by `bin/stop-hook.ts`. */
export interface BackgroundSnapshot {
  /** When the hook ran (ms since epoch). */
  at: number;
  tasks: Array<{ id: string; type: string; description: string }>;
  crons: Array<{ id: string; recurring: boolean }>;
}

/** The id the ledger gives a `/loop` wakeup: its tool result names none, and there is one at most. */
export const WAKEUP_ID = "wakeup";

/** `<task-notification>` statuses that don't end the task (a Monitor event, say). */
const LIVE_STATUSES = new Set(["running", "pending"]);
const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const EMPTY: BackgroundChanges = { started: [], ended: [] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Task ids that a block of text reports as ended. */
export function endedTaskIds(text: string): string[] {
  if (!text.includes("<task-notification>")) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(NOTIFICATION_RE)) {
    const body = match[1] ?? "";
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim();
    if (id && status && !LIVE_STATUSES.has(status)) ids.push(id);
  }
  return ids;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" ? str((b as Record<string, unknown>).text) : ""))
    .join("\n");
}

/** Starts and ends recorded by a tool result (`toolUseResult` of a user entry). */
function toolResultChanges(result: Record<string, unknown>): BackgroundChanges {
  // TaskStop: {"message":"Successfully stopped task: <id> (…)","task_id":"<id>"}
  const stopped = str(result.task_id);
  if (stopped && str(result.message)?.startsWith("Successfully stopped")) {
    return { started: [], ended: [stopped] };
  }
  // Monitor: {taskId, timeoutMs, persistent}
  const taskId = str(result.taskId);
  if (taskId && typeof result.timeoutMs === "number") {
    return { started: [{ id: taskId }], ended: [] };
  }
  // Bash with run_in_background: {stdout, …, backgroundTaskId}
  const shellId = str(result.backgroundTaskId);
  if (shellId) return { started: [{ id: shellId }], ended: [] };
  // Agent with run_in_background: {isAsync: true, status: "async_launched", agentId}
  const agentId = str(result.agentId);
  if (agentId && result.isAsync === true) return { started: [{ id: agentId }], ended: [] };
  // CronCreate: {id, humanSchedule, recurring, durable, nextFireAt}
  const cronId = str(result.id);
  if (cronId && typeof result.humanSchedule === "string") {
    return { started: [{ id: cronId, recurring: result.recurring === true }], ended: [] };
  }
  // ScheduleWakeup (/loop): {scheduledFor, clampedDelaySeconds, wasClamped[, stopped]}
  if (typeof result.scheduledFor === "number" && "clampedDelaySeconds" in result) {
    if (result.stopped === true) return { started: [], ended: [WAKEUP_ID] };
    if (result.scheduledFor > 0) return { started: [{ id: WAKEUP_ID }], ended: [] };
  }
  return EMPTY;
}

/**
 * What one parsed transcript entry says about background work.
 *
 * Main thread only: a subagent's own tool results live in its own transcript,
 * and an end the main thread is told about (a `<task-notification>`) is
 * written here whoever it is for.
 */
export function backgroundChanges(entry: Record<string, unknown>): BackgroundChanges {
  if (entry.isSidechain === true) return EMPTY;
  const type = entry.type;

  if (type === "queue-operation" && entry.operation === "enqueue") {
    const ended = endedTaskIds(typeof entry.content === "string" ? entry.content : "");
    return ended.length > 0 ? { started: [], ended } : EMPTY;
  }

  if (type === "system" && entry.subtype === "scheduled_task_fire") {
    const ended: string[] = [];
    const id = str(entry.taskId);
    if (id) ended.push(id);
    if (entry.taskKind === "loop" || entry.cronKind === "loop") ended.push(WAKEUP_ID);
    // The ledger keeps a recurring cron open when it fires.
    return ended.length > 0 ? { started: [], ended } : EMPTY;
  }

  if (type !== "user") return EMPTY;
  const result = entry.toolUseResult;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return toolResultChanges(result as Record<string, unknown>);
  }
  // An idle session is woken by the notification itself, as a user entry.
  const message = (entry.message ?? {}) as Record<string, unknown>;
  const ended = endedTaskIds(contentText(message.content));
  return ended.length > 0 ? { started: [], ended } : EMPTY;
}

/**
 * The open background items of one session: the last Stop snapshot, then every
 * transcript change written after it.
 */
export class BackgroundLedger {
  private snapshot: { at: number; ids: Set<string> } | null = null;
  private changes: Array<{ at: number; changes: BackgroundChanges }> = [];
  /** Crons known to be recurring: firing doesn't end them. */
  private readonly recurring = new Set<string>();

  /** Replace the base with a newer Stop snapshot. Older snapshots are ignored. */
  setSnapshot(snapshot: BackgroundSnapshot): void {
    if (this.snapshot && snapshot.at <= this.snapshot.at) return;
    const ids = new Set<string>();
    for (const task of snapshot.tasks) ids.add(task.id);
    for (const cron of snapshot.crons) {
      ids.add(cron.id);
      if (cron.recurring) this.recurring.add(cron.id);
    }
    this.snapshot = { at: snapshot.at, ids };
    // What the snapshot already reflects is history now.
    this.changes = this.changes.filter((c) => c.at > snapshot.at);
  }

  /** Record a transcript change written at `at` (ms). */
  apply(changes: BackgroundChanges, at: number): void {
    if (changes.started.length === 0 && changes.ended.length === 0) return;
    if (this.snapshot && at <= this.snapshot.at) return;
    for (const start of changes.started) if (start.recurring) this.recurring.add(start.id);
    this.changes.push({ at, changes });
  }

  /** Forget everything: `claude` was (re)launched, and its background work died with it. */
  clear(): void {
    this.snapshot = null;
    this.changes = [];
    this.recurring.clear();
  }

  /** Ids of the background items still open. */
  open(): string[] {
    const ids = new Set(this.snapshot?.ids ?? []);
    for (const { changes } of [...this.changes].sort((a, b) => a.at - b.at)) {
      for (const start of changes.started) ids.add(start.id);
      for (const id of changes.ended) if (!this.recurring.has(id)) ids.delete(id);
    }
    return [...ids];
  }
}

// ── Snapshot files ───────────────────────────────────────────

/** Where a session's snapshot lives, or null for an id that can't be a file name. */
export function backgroundSnapshotPath(dir: string, sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? join(dir, `${sessionId}.json`) : null;
}

/** The snapshot to save from a Stop hook's input, or null when it isn't one. */
export function snapshotFromStopInput(
  input: unknown,
  now: number,
): { sessionId: string; snapshot: BackgroundSnapshot } | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const sessionId = str(i.session_id);
  if (i.hook_event_name !== "Stop" || !sessionId) return null;
  // A CLI too old to send the registry says nothing, rather than "nothing running".
  if (!Array.isArray(i.background_tasks) && !Array.isArray(i.session_crons)) return null;
  const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      : [];
  const tasks = records(i.background_tasks).flatMap((t) => {
    const id = str(t.id);
    return id ? [{ id, type: str(t.type) ?? "task", description: str(t.description) ?? "" }] : [];
  });
  const crons = records(i.session_crons).flatMap((c) => {
    const id = str(c.id);
    return id ? [{ id, recurring: c.recurring === true }] : [];
  });
  return { sessionId, snapshot: { at: now, tasks, crons } };
}

/** Save a snapshot atomically: the reader never sees half a file. */
export function writeBackgroundSnapshot(path: string, snapshot: BackgroundSnapshot): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Delete a session's snapshot (its `claude` is being relaunched). */
export function removeBackgroundSnapshot(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Reads a session's snapshot file when it changes. `stat` per call, a parse
 * only on a new mtime, so `getInfo()` can ask on every list.
 */
export class BackgroundSnapshotReader {
  private mtimeMs = -1;

  constructor(private readonly path: string) {}

  /** The snapshot, if the file changed since the last call; otherwise null. */
  readIfChanged(): BackgroundSnapshot | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
    if (mtimeMs === this.mtimeMs) return null;
    this.mtimeMs = mtimeMs;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as BackgroundSnapshot;
      if (typeof parsed.at !== "number" || !Array.isArray(parsed.tasks)) return null;
      return { at: parsed.at, tasks: parsed.tasks, crons: parsed.crons ?? [] };
    } catch {
      return null;
    }
  }

  /** Forget the last mtime, so the next read reports the file again. */
  reset(): void {
    this.mtimeMs = -1;
  }
}
