/**
 * Today — item store over `today_items` (created in migration 042, last rebuilt in 052).
 *
 * Collectors hand in the full open set of one source at a time
 * (`applyCollection`); the store reconciles it:
 *   - new key            → open row
 *   - open row present   → fields refreshed
 *   - open row missing   → done by the collector (the ticket closed, the PR merged)
 *   - done by collector, present again → reopened
 *   - done or dismissed by the user or the agent → stays that way until the source
 *     changes after the decision (source_updated_at > completed_at reopens it)
 */

import type { Database } from "bun:sqlite";
import { nudgeQuiet } from "./nudge";
import { prStacks } from "./stacks";

export type Section = "promise" | "review" | "my_pr" | "ticket" | "promote";
export type Status = "open" | "done" | "dismissed";
export type DoneBy = "user" | "agent" | "collector";

/** One item as a collector sees it in its source. */
export interface CollectedItem {
  key: string;
  section: Section;
  title: string;
  url?: string | null;
  waitingOn?: string | null;
  stateLabel?: string | null;
  since?: string | null;
  dueDate?: string | null;
  meta?: Record<string, unknown> | null;
  /** When the source last changed; decides whether a ticked item reopens. */
  sourceUpdatedAt?: string | null;
}

export interface TodayItem {
  id: number;
  key: string;
  source: string;
  project: string;
  section: Section;
  title: string;
  url: string | null;
  waitingOn: string | null;
  stateLabel: string | null;
  since: string | null;
  dueDate: string | null;
  meta: Record<string, unknown> | null;
  note: string | null;
  status: Status;
  doneBy: DoneBy | null;
  completedAt: string | null;
  pinned: boolean;
  topDate: string | null;
  topRank: number | null;
  topReason: string | null;
  /** When `today.set_top` queued it: its reason holds until its state changes after this. */
  topAt: string | null;
  /** The session started from this item's Start button, if any. */
  sessionId: string | null;
  sessionWorkspaceId: string | null;
  /** Its session works the item's whole PR stack (see stacks.ts). */
  sessionStack: boolean;
  /** A question its session asked you (`today.ask`), until you answer. */
  question: string | null;
  askedAt: string | null;
  /** When you last nudged reviewers about this PR (`today.nudge`). */
  nudgedAt: string | null;
  /** When its state last changed (`stateKey`): how long it has waited, for "nudge due". */
  stateSince: string | null;
  /** When the board last sent its session back to it (see follow-up.ts), and for what state. */
  followUpAt: string | null;
  followUpKey: string | null;
  /** Automatic follow-ups in a row while it kept needing us; reset once it doesn't. */
  followUpAuto: number;
  sourceUpdatedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Row {
  id: number;
  key: string;
  source: string;
  project: string;
  section: Section;
  title: string;
  url: string | null;
  waiting_on: string | null;
  state_label: string | null;
  since: string | null;
  due_date: string | null;
  meta: string | null;
  note: string | null;
  status: Status;
  done_by: DoneBy | null;
  completed_at: string | null;
  pinned: number;
  top_date: string | null;
  top_rank: number | null;
  top_reason: string | null;
  top_at: string | null;
  session_id: string | null;
  session_workspace_id: string | null;
  session_stack: number;
  question: string | null;
  asked_at: string | null;
  nudged_at: string | null;
  state_since: string | null;
  follow_up_at: string | null;
  follow_up_key: string | null;
  follow_up_auto: number;
  source_updated_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toItem(row: Row): TodayItem {
  return {
    id: row.id,
    key: row.key,
    source: row.source,
    project: row.project,
    section: row.section,
    title: row.title,
    url: row.url,
    waitingOn: row.waiting_on,
    stateLabel: row.state_label,
    since: row.since,
    dueDate: row.due_date,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
    note: row.note,
    status: row.status,
    doneBy: row.done_by,
    completedAt: row.completed_at,
    pinned: row.pinned === 1,
    topDate: row.top_date,
    topRank: row.top_rank,
    topReason: row.top_reason,
    topAt: row.top_at,
    sessionId: row.session_id,
    sessionWorkspaceId: row.session_workspace_id,
    sessionStack: row.session_stack === 1,
    question: row.question,
    askedAt: row.asked_at,
    nudgedAt: row.nudged_at,
    stateSince: row.state_since,
    followUpAt: row.follow_up_at,
    followUpKey: row.follow_up_key,
    followUpAuto: row.follow_up_auto ?? 0,
    sourceUpdatedAt: row.source_updated_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize any parseable timestamp to ISO so string comparison is safe. */
export function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export interface CollectionResult {
  added: number;
  updated: number;
  reopened: number;
  completed: number;
  /** Ids of the items this collection closed (gone from the source). */
  closedIds: number[];
}

export function applyCollection(
  db: Database,
  source: string,
  project: string,
  items: CollectedItem[],
  now: string,
): CollectionResult {
  const result: CollectionResult = {
    added: 0,
    updated: 0,
    reopened: 0,
    completed: 0,
    closedIds: [],
  };
  const byKey = db.query<Row, [string]>("SELECT * FROM today_items WHERE key = ?");
  const insert = db.query(
    `INSERT INTO today_items (key, source, project, section, title, url, waiting_on, state_label,
       since, due_date, meta, source_updated_at, state_since, last_seen_at, created_at, updated_at)
     VALUES ($key, $source, $project, $section, $title, $url, $waitingOn, $stateLabel,
       $since, $dueDate, $meta, $sourceUpdatedAt, COALESCE($since, $now), $now, $now, $now)`,
  );
  const refresh = db.query(
    `UPDATE today_items SET source = $source, project = $project, section = $section,
       title = $title, url = $url, waiting_on = $waitingOn, state_label = $stateLabel,
       since = $since, due_date = $dueDate, meta = $meta, source_updated_at = $sourceUpdatedAt,
       state_since = CASE WHEN $stateChanged THEN $now ELSE state_since END,
       last_seen_at = $now, updated_at = $now,
       status = CASE WHEN $reopen THEN 'open' ELSE status END,
       done_by = CASE WHEN $reopen THEN NULL ELSE done_by END,
       completed_at = CASE WHEN $reopen THEN NULL ELSE completed_at END
     WHERE key = $key`,
  );

  db.transaction(() => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const params = {
        $key: item.key,
        $source: source,
        $project: project,
        $section: item.section,
        $title: item.title,
        $url: item.url ?? null,
        $waitingOn: item.waitingOn ?? null,
        $stateLabel: item.stateLabel ?? null,
        $since: iso(item.since),
        $dueDate: item.dueDate ?? null,
        $meta: item.meta ? JSON.stringify(item.meta) : null,
        $sourceUpdatedAt: iso(item.sourceUpdatedAt),
        $now: now,
      };
      const existing = byKey.get(item.key);
      if (!existing) {
        insert.run(params);
        result.added++;
        continue;
      }
      const reopen = shouldReopen(existing, iso(item.sourceUpdatedAt));
      const before = stateKey(
        existing.section,
        existing.meta ? JSON.parse(existing.meta) : null,
        existing.state_label,
      );
      const stateChanged =
        before !== stateKey(item.section, item.meta ?? null, item.stateLabel ?? null);
      refresh.run({ ...params, $reopen: reopen ? 1 : 0, $stateChanged: stateChanged ? 1 : 0 });
      if (reopen) result.reopened++;
      else result.updated++;
    }

    const open = db
      .query<{ id: number; key: string }, [string]>(
        "SELECT id, key FROM today_items WHERE source = ? AND status = 'open'",
      )
      .all(source);
    const complete = db.query(
      `UPDATE today_items SET status = 'done', done_by = 'collector', completed_at = ?, updated_at = ?
       WHERE key = ?`,
    );
    for (const { id, key } of open) {
      if (seen.has(key)) continue;
      complete.run(now, now, key);
      result.completed++;
      result.closedIds.push(id);
    }
  }).immediate();
  return result;
}

/**
 * What "its state changed" means for `state_since`: a PR's state kind (its label also carries
 * counts that move without anything changing hands), anything else's state label.
 */
export function stateKey(
  section: Section,
  meta: Record<string, unknown> | null,
  stateLabel: string | null,
): string {
  return section === "my_pr" ? String(meta?.state ?? "") : (stateLabel ?? "");
}

function shouldReopen(row: Row, sourceUpdatedAt: string | null): boolean {
  if (row.status === "open") return false;
  if (row.done_by === "collector") return true;
  // The user's (or the agent's) decision holds until the source moves after it.
  return Boolean(sourceUpdatedAt && row.completed_at && sourceUpdatedAt > row.completed_at);
}

export interface ListOptions {
  /** Also return items finished at or after this time (so today's ticks stay visible). */
  doneSince?: string;
  project?: string;
  section?: Section;
  /** Default "open". */
  status?: Status | "all";
  doneBy?: DoneBy;
}

export function listItems(db: Database, options: ListOptions = {}): TodayItem[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  const status = options.status ?? "open";
  if (options.doneSince) params.$doneSince = options.doneSince;
  if (status === "open") {
    // Open items, plus whatever was finished since `doneSince` (shown struck through).
    where.push(
      options.doneSince ? "(status = 'open' OR completed_at >= $doneSince)" : "status = 'open'",
    );
  } else if (status !== "all") {
    where.push("status = $status");
    params.$status = status;
    if (options.doneSince) where.push("completed_at >= $doneSince");
  } else if (options.doneSince) {
    where.push("(status = 'open' OR completed_at >= $doneSince)");
  }
  if (options.project) {
    where.push("project = $project");
    params.$project = options.project;
  }
  if (options.section) {
    where.push("section = $section");
    params.$section = options.section;
  }
  if (options.doneBy) {
    where.push("done_by = $doneBy");
    params.$doneBy = options.doneBy;
  }
  const sql = `SELECT * FROM today_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY COALESCE(due_date, '9999') ASC, COALESCE(since, created_at) ASC`;
  return db.query<Row, [Record<string, string>]>(sql).all(params).map(toItem);
}

export function getItem(db: Database, ref: number | string): TodayItem | null {
  const row =
    typeof ref === "number"
      ? db.query<Row, [number]>("SELECT * FROM today_items WHERE id = ?").get(ref)
      : db.query<Row, [string]>("SELECT * FROM today_items WHERE key = ?").get(ref);
  return row ? toItem(row) : null;
}

function requireItem(db: Database, ref: number | string): TodayItem {
  const item = getItem(db, ref);
  if (!item) throw new Error(`No today item ${ref}`);
  return item;
}

/**
 * The sessions these just-closed items finish: every item a session works (its whole stack) is
 * closed now. Items still open, or with no session, finish nothing.
 */
export function finishedSessions(db: Database, closedIds: number[]): string[] {
  const finished = new Set<string>();
  const stillOpen = db.query<{ one: number }, [string]>(
    "SELECT 1 AS one FROM today_items WHERE session_id = ? AND status = 'open' LIMIT 1",
  );
  for (const id of closedIds) {
    const item = getItem(db, id);
    if (!item?.sessionId || item.status === "open") continue;
    if (!stillOpen.get(item.sessionId)) finished.add(item.sessionId);
  }
  return [...finished];
}

export function setNudged(db: Database, ref: number | string, now: string): TodayItem {
  const item = requireItem(db, ref);
  db.query("UPDATE today_items SET nudged_at = ?, updated_at = ? WHERE id = ?").run(
    now,
    now,
    item.id,
  );
  return requireItem(db, item.id);
}

export function setStatus(
  db: Database,
  ref: number | string,
  status: Status,
  by: Exclude<DoneBy, "collector">,
  now: string,
  note?: string,
): TodayItem {
  const item = requireItem(db, ref);
  db.query(
    `UPDATE today_items SET status = $status, done_by = $doneBy, completed_at = $completedAt,
       note = COALESCE($note, note), updated_at = $now WHERE id = $id`,
  ).run({
    $status: status,
    $doneBy: status === "open" ? null : by,
    $completedAt: status === "open" ? null : now,
    $note: note ?? null,
    $now: now,
    $id: item.id,
  });
  return requireItem(db, item.id);
}

/**
 * Merge fields into an item's meta now, ahead of its source: the next collection replaces meta
 * with what the source says, which by then agrees (e.g. a snooze just written to Linear).
 */
export function patchMeta(
  db: Database,
  ref: number | string,
  patch: Record<string, unknown>,
  now: string,
): TodayItem {
  const item = requireItem(db, ref);
  db.query("UPDATE today_items SET meta = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify({ ...item.meta, ...patch }),
    now,
    item.id,
  );
  return requireItem(db, item.id);
}

export function setPinned(
  db: Database,
  ref: number | string,
  pinned: boolean,
  now: string,
): TodayItem {
  const item = requireItem(db, ref);
  db.query("UPDATE today_items SET pinned = ?, updated_at = ? WHERE id = ?").run(
    pinned ? 1 : 0,
    now,
    item.id,
  );
  return requireItem(db, item.id);
}

/**
 * Remember the session started for an item, replacing any earlier one. `stack`: the session
 * works the item's whole PR stack.
 */
export function setSession(
  db: Database,
  ref: number | string,
  session: { sessionId: string; workspaceId: string },
  now: string,
  stack = false,
): TodayItem {
  const item = requireItem(db, ref);
  db.query(
    `UPDATE today_items SET session_id = ?, session_workspace_id = ?, session_stack = ?,
       updated_at = ? WHERE id = ?`,
  ).run(session.sessionId, session.workspaceId, stack ? 1 : 0, now, item.id);
  return requireItem(db, item.id);
}

/**
 * A PR that joined a stack after its session started (a new PR was stacked on it) gets that
 * session too. Only a session that works the stack as a whole (`session_stack`) spreads, and
 * only when no PR in the stack has a different one.
 */
export function linkStackSessions(db: Database, now: string): number {
  let linked = 0;
  for (const stack of prStacks(listItems(db))) {
    const holders = stack.filter((member) => member.sessionId);
    const lead = holders.find((member) => member.sessionStack && member.sessionWorkspaceId);
    if (!lead || holders.some((member) => member.sessionId !== lead.sessionId)) continue;
    const session = { sessionId: lead.sessionId!, workspaceId: lead.sessionWorkspaceId! };
    for (const member of stack) {
      if (member.sessionId) continue;
      setSession(db, member.id, session, now, true);
      linked++;
    }
  }
  return linked;
}

/**
 * The board sent these items' session back to them. `auto`: counts toward the automatic cap;
 * a follow-up you asked for resets it.
 */
export function setFollowedUp(
  db: Database,
  updates: Array<{ id: number; key: string }>,
  now: string,
  auto: boolean,
): void {
  const update = db.query(
    `UPDATE today_items SET follow_up_at = $now, follow_up_key = $key,
       follow_up_auto = CASE WHEN $auto THEN follow_up_auto + 1 ELSE 0 END, updated_at = $now
     WHERE id = $id`,
  );
  db.transaction(() => {
    for (const { id, key } of updates)
      update.run({ $now: now, $key: key, $auto: auto ? 1 : 0, $id: id });
  }).immediate();
}

/** Items that stopped needing us start their automatic follow-up count over. */
export function resetFollowUps(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const reset = db.query("UPDATE today_items SET follow_up_auto = 0 WHERE id = ?");
  db.transaction(() => {
    for (const id of ids) reset.run(id);
  }).immediate();
}

/** A session handed its work to another (`session.handoff`): its items follow. */
export function followHandoff(
  db: Database,
  from: string,
  to: { sessionId: string; workspaceId: string },
  now: string,
): number {
  return db
    .query(
      `UPDATE today_items SET session_id = ?, session_workspace_id = ?, updated_at = ?
        WHERE session_id = ?`,
    )
    .run(to.sessionId, to.workspaceId, now, from).changes;
}

export interface TopPick {
  key: string;
  reason?: string;
}

/** Replace the top picks for one local date. Unknown keys are reported, not fatal. */
export function setTop(
  db: Database,
  date: string,
  picks: TopPick[],
  now: string,
): { set: number; missing: string[]; quiet: string[] } {
  const missing: string[] = [];
  // Nudged within NUDGE_QUIET_DAYS: it waits on reviewers, so it isn't yours to do yet.
  const quiet: string[] = [];
  let set = 0;
  db.transaction(() => {
    db.query(
      "UPDATE today_items SET top_date = NULL, top_rank = NULL, top_reason = NULL, top_at = NULL WHERE top_date = ?",
    ).run(date);
    const mark = db.query(
      `UPDATE today_items SET top_date = $date, top_rank = $rank, top_reason = $reason, top_at = $now,
         updated_at = $now
       WHERE key = $key`,
    );
    const kept = picks.filter((pick) => {
      const item = getItem(db, pick.key);
      if (item && nudgeQuiet(item, date)) quiet.push(pick.key);
      return !quiet.includes(pick.key);
    });
    kept.forEach((pick, index) => {
      const changes = mark.run({
        $date: date,
        $rank: index + 1,
        $reason: pick.reason ?? null,
        $now: now,
        $key: pick.key,
      }).changes;
      if (changes === 0) missing.push(pick.key);
      else set++;
    });
  }).immediate();
  return { set, missing, quiet };
}

export interface AddItemInput {
  key?: string;
  project: string;
  section?: Section;
  title: string;
  url?: string;
  waitingOn?: string;
  dueDate?: string;
  since?: string;
  note?: string;
}

/** Add (or update, by key) an item nobody collects: an ad-hoc promise. */
export function addItem(db: Database, input: AddItemInput, now: string): TodayItem {
  const key = input.key ?? `manual:${crypto.randomUUID().slice(0, 8)}`;
  const existing = getItem(db, key);
  if (existing && existing.source !== "manual") {
    throw new Error(`${key} belongs to collector ${existing.source}; it can't be edited by hand`);
  }
  db.query(
    `INSERT INTO today_items (key, source, project, section, title, url, waiting_on, due_date, since,
       note, created_at, updated_at)
     VALUES ($key, 'manual', $project, $section, $title, $url, $waitingOn, $dueDate, $since, $note, $now, $now)
     ON CONFLICT(key) DO UPDATE SET project = $project, section = $section, title = $title,
       url = $url, waiting_on = $waitingOn, due_date = $dueDate, since = $since,
       note = COALESCE($note, note), updated_at = $now`,
  ).run({
    $key: key,
    $project: input.project,
    $section: input.section ?? "promise",
    $title: input.title,
    $url: input.url ?? null,
    $waitingOn: input.waitingOn ?? null,
    $dueDate: input.dueDate ?? null,
    $since: iso(input.since) ?? now,
    $note: input.note ?? null,
    $now: now,
  });
  return requireItem(db, key);
}

// ── The note ─────────────────────────────────────────────────

/** Write the day's note, with the keys of the live top picks it was written over. */
export function setNote(
  db: Database,
  date: string,
  text: string,
  now: string,
  picks: string[] = [],
): void {
  db.query(
    `INSERT INTO today_notes (date, text, updated_at, picks) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at,
       picks = excluded.picks`,
  ).run(date, text, now, JSON.stringify(picks));
}

/** The day's note and when it was last written (the morning sweep, then any day refresh). */
export function getNote(
  db: Database,
  date: string,
): { text: string; updatedAt: string; picks: string[] | null } | null {
  const row = db
    .query<{ text: string; updated_at: string; picks: string | null }, [string]>(
      "SELECT text, updated_at, picks FROM today_notes WHERE date = ?",
    )
    .get(date);
  if (!row) return null;
  return {
    text: row.text,
    updatedAt: row.updated_at,
    picks: row.picks ? (JSON.parse(row.picks) as string[]) : null,
  };
}
