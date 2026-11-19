/**
 * "Needs your answer": a session working an item asks you something only you can answer.
 *
 * `today.ask` writes the question on the item, so the board shows it under the item and the
 * session's pill turns red. It stays until your next message reaches that session: a turn starting
 * after the session's own turn had ended. A question nobody answers goes out once through notify.send (your phone, desktop, or whatever delivery you set up).
 */

import type { Database } from "bun:sqlite";
import { getItem, type Row, type TodayItem, toItem } from "./store";

/** A still-open question this old (minutes) goes out through notify.send once. */
export const PHONE_AFTER_MINUTES = 10;

export function setQuestion(
  db: Database,
  item: TodayItem,
  question: string,
  now: string,
): TodayItem {
  db.query(
    `UPDATE today_items SET question = ?, asked_at = ?, question_notified_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(question, now, now, item.id);
  return getItem(db, item.id)!;
}

export function clearQuestion(db: Database, id: number, now: string): void {
  db.query(
    `UPDATE today_items SET question = NULL, asked_at = NULL, question_notified_at = NULL,
            updated_at = ? WHERE id = ?`,
  ).run(now, id);
}

/** The open items a session works on (usually one). */
export function itemsForSession(db: Database, sessionId: string): TodayItem[] {
  return db
    .query<Row, [string]>("SELECT * FROM today_items WHERE session_id = ? AND status = 'open'")
    .all(sessionId)
    .map(toItem);
}

/** Open questions asked before `cutoff` that haven't gone out through notify yet. */
export function questionsToPhone(db: Database, cutoff: string): TodayItem[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM today_items
        WHERE question IS NOT NULL AND status = 'open' AND question_notified_at IS NULL
          AND asked_at <= ?`,
    )
    .all(cutoff)
    .map(toItem);
}

export function markPhoned(db: Database, id: number, now: string): void {
  db.query("UPDATE today_items SET question_notified_at = ? WHERE id = ?").run(now, id);
}

/** The parts of `session.status_changed` read here. */
export interface StatusChange {
  sessionId: string;
  runtimeStatus: string;
  /** Present only on a runtime transition; a disposition change leaves it out. */
  previousRuntimeStatus?: string;
}

const WAITING_ON_A_PROMPT = new Set(["awaiting_input", "awaiting_approval"]);

/**
 * Did you just answer? A new turn started after the last one ended. Leaving a permission or
 * input prompt is not an answer to the question, and neither is a disposition change (no
 * `previousRuntimeStatus`), such as the `blocked` that asking sets itself.
 */
export function isAnswer(change: StatusChange): boolean {
  const before = change.previousRuntimeStatus;
  return (
    change.runtimeStatus === "running" &&
    before !== undefined &&
    before !== "running" &&
    !WAITING_ON_A_PROMPT.has(before)
  );
}

/** Did the session just stop on a prompt in its pane (an approval, a choice)? */
export function isPromptWaiting(change: StatusChange): boolean {
  return (
    WAITING_ON_A_PROMPT.has(change.runtimeStatus) &&
    change.previousRuntimeStatus !== undefined &&
    change.previousRuntimeStatus !== change.runtimeStatus
  );
}

export interface AskingDeps {
  db: () => Database;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  emit: (event: string, payload: Record<string, unknown>) => void;
  /** Tell open pages the board changed. */
  changed: (reason: string) => void;
  warn: (message: string, meta: Record<string, unknown>) => void;
  now: () => Date;
}

/** The toast and desktop notification every open Anima tab shows (`today.needs_you`). */
export interface NeedsYou {
  itemId: number;
  title: string;
  message: string;
  /** The session to open (same origin), else the item's own page. */
  url: string | null;
}

function needsYou(item: TodayItem, message: string): NeedsYou {
  return {
    itemId: item.id,
    title: `Needs your answer · ${item.title}`.slice(0, 120),
    message,
    url:
      item.sessionId && item.sessionWorkspaceId
        ? `/chat/${item.sessionWorkspaceId}/${item.sessionId}`
        : item.url,
  };
}

export const NEEDS_YOU_EVENT = "today.needs_you";

export function createAsking(deps: AskingDeps) {
  const setDisposition = (sessionId: string, disposition: "blocked" | "open") =>
    deps.call("session.set_status", { sessionId, disposition }).catch((error: unknown) =>
      deps.warn("Today: couldn't set the session's status", {
        sessionId,
        disposition,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  return {
    /** A session asks you something about an item. */
    async ask(item: TodayItem, question: string): Promise<TodayItem> {
      const asked = setQuestion(deps.db(), item, question, deps.now().toISOString());
      deps.changed("today.ask");
      // Blocked: the Active list and the pill agree it waits on you, not that it's finished.
      if (asked.sessionId) await setDisposition(asked.sessionId, "blocked");
      deps.emit(NEEDS_YOU_EVENT, { ...needsYou(asked, question) });
      return asked;
    },

    /** `session.status_changed`: clear a question you answered; speak up when a pane prompt waits. */
    async onStatus(change: StatusChange): Promise<void> {
      const items = itemsForSession(deps.db(), change.sessionId);
      if (items.length === 0) return;
      if (isAnswer(change)) {
        const asked = items.filter((item) => item.question);
        if (asked.length === 0) return;
        const at = deps.now().toISOString();
        for (const item of asked) clearQuestion(deps.db(), item.id, at);
        await setDisposition(change.sessionId, "open");
        deps.changed("today.answered");
        return;
      }
      if (isPromptWaiting(change)) {
        const message =
          change.runtimeStatus === "awaiting_approval"
            ? "I'm waiting on your approval."
            : "I'm waiting on your answer.";
        // One toast per session: a stack's session works several items.
        const first = items[0]!;
        const more = items.length > 1 ? ` (+${items.length - 1} in its stack)` : "";
        const toast = needsYou(first, message);
        deps.emit(NEEDS_YOU_EVENT, { ...toast, title: `${toast.title}${more}`.slice(0, 140) });
      }
    },

    /** Questions unanswered for PHONE_AFTER_MINUTES go out through notify.send, once each. */
    async phoneSweep(): Promise<number> {
      const nowMs = deps.now().getTime();
      const cutoff = new Date(nowMs - PHONE_AFTER_MINUTES * 60_000).toISOString();
      let sent = 0;
      for (const item of questionsToPhone(deps.db(), cutoff)) {
        try {
          await deps.call("notify.send", {
            title: "Needs your answer",
            message: `${item.title}\n\n${item.question}`,
            source: "today",
          });
          markPhoned(deps.db(), item.id, deps.now().toISOString());
          sent++;
        } catch (error) {
          deps.warn("Today: couldn't send the question through notify", {
            itemId: item.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return sent;
    },
  };
}
