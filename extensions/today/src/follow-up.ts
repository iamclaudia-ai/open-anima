/**
 * Today — sending an item's session back to it. A session finishes its turn (fixes pushed, a
 * rebase done, marked done), then the PR moves on without it: a reviewer comments, an AI
 * reviewer looks at the new push, main moves and it conflicts again. Nothing would pick it back
 * up, and its pill just says the session is idle. So after each collection the board prompts the
 * session itself (`autoFollowUps`), and the page has a Continue button for the rest
 * (`today.follow_up`). The prompt carries the same gates as the first one (approvals.ts): the
 * session prepares the fix on this machine, then asks before pushing or replying.
 * Pure, shared by the server and the page.
 */

import { ASK_FIRST, gateLine } from "./approvals";
import type { Approvals } from "./config";
import { askLine, BOT_THREADS, FINISH, noteLine } from "./launch";

/** The user's PR states a session can work on its own: the board sends it back for these. */
export const FOLLOW_UP_KINDS: ReadonlySet<string> = new Set([
  "conflicts",
  "checks_failing",
  "changes_requested",
  "your_turn",
  "open_comments",
]);

/** The session has been quiet this long: not mid-thought, not just pushed and waiting on CI. */
export const FOLLOW_UP_QUIET_MS = 10 * 60_000;
/** At most one automatic follow-up per item this often. */
export const FOLLOW_UP_COOLDOWN_MS = 30 * 60_000;
/** Automatic follow-ups in a row while the PR keeps needing us; then it waits for Continue. */
export const FOLLOW_UP_MAX_AUTO = 3;

export interface FollowUpItem {
  id: number;
  key: string;
  section: string;
  status: string;
  title: string;
  url: string | null;
  stateLabel: string | null;
  meta: Record<string, unknown> | null;
  sessionId: string | null;
  sessionWorkspaceId: string | null;
  question: string | null;
  sourceUpdatedAt?: string | null;
  followUpAt?: string | null;
  followUpKey?: string | null;
  followUpAuto?: number;
}

/** A session as the attention queue reports it (a resolved one isn't in it). */
export interface LiveSession {
  runtimeStatus: string;
  disposition?: string;
  lastActivity?: string;
  worktreeSetup?: { state: string } | null;
}

/** One PR state, once: a new comment or push makes a new key, a recount doesn't. */
export function followUpKey(item: Pick<FollowUpItem, "meta" | "stateLabel" | "sourceUpdatedAt">) {
  const state = item.meta?.state ?? item.stateLabel ?? "";
  return `${String(state)}@${item.sourceUpdatedAt ?? ""}`;
}

/** In the middle of something: a turn, a prompt in its pane, its worktree being made. */
export function sessionBusy(session: LiveSession | undefined): boolean {
  if (!session) return false;
  return (
    session.runtimeStatus === "running" ||
    session.runtimeStatus === "awaiting_input" ||
    session.runtimeStatus === "awaiting_approval" ||
    session.worktreeSetup?.state === "running"
  );
}

/** Left for the user on purpose: a question, something to review, a stalled API call. */
function waitsOnUser(item: FollowUpItem, session: LiveSession | undefined): boolean {
  if (item.question) return true;
  if (!session) return false;
  return (
    session.disposition === "blocked" ||
    session.disposition === "needs_review" ||
    session.runtimeStatus === "api_error"
  );
}

/** One of the user's open PRs, worked by a session, in a state a session can move forward. */
export function needsFollowUp(item: FollowUpItem): boolean {
  return (
    item.section === "my_pr" &&
    item.status === "open" &&
    Boolean(item.sessionId && item.sessionWorkspaceId) &&
    item.meta?.actionable === true &&
    FOLLOW_UP_KINDS.has(String(item.meta?.state))
  );
}

export interface FollowUp<T extends FollowUpItem = FollowUpItem> {
  sessionId: string;
  items: T[];
}

/**
 * What to send back automatically now, one prompt per session (a stack's session gets all its
 * PRs in one). An item qualifies when it needs a follow-up, its session is idle and has been quiet
 * `FOLLOW_UP_QUIET_MS`, nothing waits on the user, and this state of the PR hasn't been followed up
 * yet, within the cooldown and the cap.
 */
export function autoFollowUps<T extends FollowUpItem>(
  items: T[],
  live: ReadonlyMap<string, LiveSession>,
  nowMs: number,
): FollowUp<T>[] {
  const bySession = new Map<string, T[]>();
  for (const item of items) {
    if (!needsFollowUp(item)) continue;
    const session = live.get(item.sessionId!);
    if (sessionBusy(session) || waitsOnUser(item, session)) continue;
    if (session?.lastActivity && nowMs - Date.parse(session.lastActivity) < FOLLOW_UP_QUIET_MS) {
      continue;
    }
    if (item.followUpKey === followUpKey(item)) continue;
    if (item.followUpAt && nowMs - Date.parse(item.followUpAt) < FOLLOW_UP_COOLDOWN_MS) continue;
    if ((item.followUpAuto ?? 0) >= FOLLOW_UP_MAX_AUTO) continue;
    bySession.set(item.sessionId!, [...(bySession.get(item.sessionId!) ?? []), item]);
  }
  return [...bySession].map(([sessionId, members]) => ({ sessionId, items: members }));
}

/** Items whose automatic count should start over: they stopped needing us. */
export function followUpsToReset(items: FollowUpItem[]): number[] {
  return items
    .filter((item) => (item.followUpAuto ?? 0) > 0 && !needsFollowUp(item))
    .map((item) => item.id);
}

const HOW = `Handle it the way you did before: conflicts → rebase onto the latest main (a stack: \`gh-stack sync\`). Failing checks → find out why and fix them. Review comments → fix what's real and reply in each thread. ${BOT_THREADS} Once a person's feedback is addressed and pushed, re-requesting their review is what hands it back to them.`;

/**
 * The prompt that sends a session back to its items. `auto`: the board noticed by itself, so
 * it says what changed and that "already handled" is a fine answer.
 */
export function followUpPrompt(
  items: Pick<FollowUpItem, "key" | "title" | "url" | "stateLabel" | "section">[],
  options: { auto: boolean; context?: string; approvals?: Approvals },
): string {
  const lines = items.map(
    (item) =>
      `- ${item.title}${item.stateLabel ? `: **${item.stateLabel}**` : ""}${item.url ? `\n  ${item.url}` : ""}`,
  );
  const prs = items.every((item) => item.section === "my_pr");
  const opening = options.auto
    ? `From my Today board: ${items.length === 1 ? "this PR" : "these PRs"} moved on since your last turn, so please pick ${items.length === 1 ? "it" : "them"} back up.`
    : `From my Today board: please pick this back up and see what it needs now.`;
  return [
    opening,
    lines.join("\n"),
    noteLine(options.context),
    prs ? HOW : null,
    gateLine(options.approvals ?? ASK_FIRST),
    options.auto
      ? "The board sent this by itself when the PR's state changed after you finished. If you already handled it, or it turns out there's nothing to do, say so in a line and stop."
      : null,
    askLine(items[0]!.key),
    FINISH,
  ]
    .filter(Boolean)
    .join("\n\n");
}
