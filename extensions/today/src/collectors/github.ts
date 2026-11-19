/**
 * GitHub collectors, one repo at a time, run with cwd = the project folder (so a `gh` that
 * picks its account by folder picks the project's).
 *
 * Both run the read-only scripts bundled in `extensions/today/tools` (bash, `gh`, `jq`), which
 * you can also run in a terminal to see the same thing:
 * - reviews: `check-review-queue --json -R <repo>`, so the board lists exactly what the
 *   review queue lists: requested and follow-up PRs, minus drafts, approved,
 *   quieted and team-only requests. Quieting a PR there clears it here too.
 * - mine: `check-my-prs --json --all -R <repo>`, so each PR's state follows the same rules
 *   you see in your terminal. `prState` turns a row into one label and whether a session
 *   can act on the PR right now.
 */

import { join } from "node:path";
import type { CollectedItem } from "../store";
import type { RunCommand } from "./run";

/** The bundled scripts, by absolute path: no PATH lookup, nothing to install but gh and jq. */
export const TOOLS_DIR = join(import.meta.dir, "..", "..", "tools");
export const CHECK_REVIEW_QUEUE = join(TOOLS_DIR, "check-review-queue");
export const CHECK_MY_PRS = join(TOOLS_DIR, "check-my-prs");

// ── Reviews (check-review-queue) ─────────────────────────────

export interface ReviewQueueRow {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  section: "requested" | "team" | "followup";
  createdAt?: string;
  updatedAt: string;
  lastState: string | null;
  pushedSince: boolean;
  replies: number;
  /** The open PR whose head is this PR's base; null on the default branch. */
  parent?: number | null;
  /** Every open PR in its stack, bottom first (`inQueue`: in your review queue); null alone. */
  stack?: Array<{ number: number; title: string; url: string; inQueue: boolean }> | null;
}

export function reviewToItem(row: ReviewQueueRow): CollectedItem {
  const label =
    row.section === "followup"
      ? row.replies > 0
        ? `${row.replies} repl${row.replies === 1 ? "y" : "ies"} to you`
        : "pushed since your review"
      : row.lastState
        ? "re-requested"
        : "review requested";
  return {
    key: `review:${row.repo}#${row.number}`,
    section: "review",
    title: `#${row.number} ${row.title}`,
    url: row.url,
    waitingOn: row.author,
    stateLabel: label,
    since: row.createdAt ?? row.updatedAt,
    sourceUpdatedAt: row.updatedAt,
    meta: {
      repo: row.repo,
      number: row.number,
      queue: row.section,
      lastState: row.lastState,
      parent: row.parent ?? null,
      // The whole stack, so one session checks it all out and reviews it bottom up.
      stack:
        row.stack?.map(({ number, title, url, inQueue }) => ({ number, title, url, inQueue })) ??
        null,
    },
  };
}

export async function collectReviews(
  run: RunCommand,
  options: { cwd: string; repo: string },
): Promise<CollectedItem[]> {
  const stdout = await run([CHECK_REVIEW_QUEUE, "--json", "-R", options.repo], {
    cwd: options.cwd,
  });
  const rows = JSON.parse(stdout) as ReviewQueueRow[];
  return rows.filter((row) => row.section !== "team").map(reviewToItem);
}

// ── Your own PRs (check-my-prs) ──────────────────────────────

/** One row of `check-my-prs --json` (the fields the board reads). */
export interface MyPrRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt?: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  defaultBranch: string;
  conflicts: boolean;
  reviewDecision: string;
  /** Approved by GitHub's rules, and not only by CPRA_DESIGNERS (opt-in) */
  approved: boolean;
  designerOnly: boolean;
  /** Unresolved review threads that need us: every bot thread, and a person's they spoke last in */
  openThreads: number;
  /** The bot share of openThreads (CodeRabbit's are ours until resolved), and who opened them */
  botThreads?: number;
  botThreadAuthors?: string[];
  /** A person's unresolved threads we answered last: waiting on their reply */
  waitingThreads?: number;
  waitingThreadsOn?: string[];
  requested: string[];
  approvedBy: string[];
  changesBy: string[];
  /** Asked again after reviewing an older commit */
  reReview: { login: string; state: string }[];
  /** Commented on the current head and not asked again: our move */
  yourTurn: string[];
  /** Commented on an older commit and not asked again: re-request them? */
  notReRequested: string[];
  /** The open PR under this one, if stacked */
  parent: number | null;
  /** Whole chain approved down to the default branch; null when the base is no open PR */
  parentApproved: boolean | null;
  /** The nearest PR in the chain that holds this one up */
  waitingOn: number | null;
  totalChecks?: number;
  failedChecks?: number;
  pendingChecks?: number;
  checksUnavailable?: boolean;
}

export type PrStateKind =
  | "conflicts"
  | "checks_failing"
  | "changes_requested"
  | "your_turn"
  | "open_comments"
  | "re_request"
  | "ready"
  | "waiting_on_parent"
  | "unknown_base"
  | "ci_running"
  | "checks_unknown"
  | "needs_engineer"
  | "re_review"
  | "awaiting_reply"
  | "awaiting_review"
  | "draft";

export interface PrState {
  kind: PrStateKind;
  label: string;
  /** A session can move it forward right now */
  actionable: boolean;
  /** Who it waits on, when the label doesn't already say */
  waitingOn: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const names = (logins: string[]) =>
  logins.length > 2 ? `${logins.slice(0, 2).join(", ")} +${logins.length - 2}` : logins.join(", ");

/** "2 open comments · 1 CodeRabbit comment": people's threads, then the bots'. */
function threadsLabel(row: MyPrRow): string {
  const bots = Math.min(row.botThreads ?? 0, row.openThreads);
  const people = row.openThreads - bots;
  const bot = (row.botThreadAuthors ?? []).every((login) => login === "coderabbitai")
    ? "CodeRabbit"
    : "bot";
  return [people > 0 && plural(people, "open comment"), bots > 0 && plural(bots, `${bot} comment`)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The one state that decides a PR's next move; the first match wins. Approved
 * means check-my-prs's `approved`: approvals only from CPRA_DESIGNERS (opt-in) don't count.
 * Drafts only surface what a session can fix (conflicts, CI, open threads).
 */
export function prState(row: MyPrRow): PrState {
  const act = (kind: PrStateKind, label: string): PrState => ({
    kind,
    label,
    actionable: true,
    waitingOn: null,
  });
  const wait = (kind: PrStateKind, label: string, waitingOn: string | null = null): PrState => ({
    kind,
    label,
    actionable: false,
    waitingOn,
  });
  const failed = row.failedChecks ?? 0;
  const pending = row.pendingChecks ?? 0;
  const threads = row.openThreads;
  const reReviewers = row.reReview.map((r) => r.login);

  if (row.conflicts) return act("conflicts", "conflicts");
  if (failed > 0) return act("checks_failing", `${plural(failed, "check")} failing`);
  if (row.isDraft) {
    return threads > 0 ? act("open_comments", threadsLabel(row)) : wait("draft", "draft");
  }
  if (row.changesBy.some((login) => !reReviewers.includes(login))) {
    return act("changes_requested", "changes requested");
  }
  if (row.yourTurn.length > 0) return act("your_turn", `your turn: ${names(row.yourTurn)}`);
  if (threads > 0) {
    const comments = threadsLabel(row);
    return act("open_comments", row.approved ? `approved · ${comments}` : comments);
  }
  if (row.notReRequested.length > 0) {
    return act("re_request", `re-request ${names(row.notReRequested)}?`);
  }
  // Asked to look again: not ready until they do, approved or not.
  if (reReviewers.length > 0) return wait("re_review", `re-review: ${names(reReviewers)}`);
  // We answered a reviewer's thread: it's theirs to reply to (or resolve).
  if ((row.waitingThreads ?? 0) > 0) {
    const who = names(row.waitingThreadsOn ?? []);
    const label = who ? `waiting on ${who}'s reply` : "waiting on a reply";
    return wait("awaiting_reply", row.approved ? `approved · ${label}` : label, who || null);
  }
  if (row.approved) {
    if (row.parentApproved === false && row.waitingOn !== null) {
      return wait("waiting_on_parent", `approved · waiting on #${row.waitingOn}`);
    }
    if (row.parentApproved === null) {
      return wait("unknown_base", `approved · base ${row.baseRefName}`);
    }
    if (pending > 0) return wait("ci_running", "approved · CI running");
    if (row.checksUnavailable) return wait("checks_unknown", "approved · checks unavailable");
    return act("ready", "ready to merge");
  }
  if (pending > 0) return wait("ci_running", "CI running");
  if (row.designerOnly) return wait("needs_engineer", "needs an engineer's approval");
  return wait("awaiting_review", "awaiting review", names(row.requested) || null);
}

export function myPrToItem(row: MyPrRow, repo: string): CollectedItem {
  const state = prState(row);
  return {
    key: `pr:${repo}#${row.number}`,
    section: "my_pr",
    title: `#${row.number} ${row.title}`,
    url: row.url,
    waitingOn: state.waitingOn,
    stateLabel: state.label,
    since: row.createdAt ?? row.updatedAt,
    sourceUpdatedAt: row.updatedAt,
    meta: {
      repo,
      number: row.number,
      branch: row.headRefName,
      state: state.kind,
      actionable: state.actionable,
      reviewers: row.requested,
      approvedBy: row.approvedBy,
      openThreads: row.openThreads,
      botThreads: row.botThreads ?? 0,
      waitingThreads: row.waitingThreads ?? 0,
      parent: row.parent,
    },
  };
}

/** Runs in the project folder: check-my-prs's CI cache lives in its git common dir, shared with a terminal. */
export async function collectMyPrs(
  run: RunCommand,
  options: { cwd: string; repo: string },
): Promise<CollectedItem[]> {
  const stdout = await run([CHECK_MY_PRS, "--json", "--all", "-R", options.repo], {
    cwd: options.cwd,
  });
  const rows = JSON.parse(stdout) as MyPrRow[];
  return rows.map((row) => myPrToItem(row, options.repo));
}
