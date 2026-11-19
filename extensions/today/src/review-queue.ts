/**
 * The Reviews page's "Review all" button (`today.review_queue`): one session per project that
 * works through the review queue, one PR (or stack) at a time, chaining fresh sessions with
 * handoffs when its context gets heavy. Every review it takes on is linked to that session, and
 * the links follow each handoff (`followHandoff`), so the board shows the chain working them.
 *
 * By default (the `post` gate, approvals.ts) the queue only drafts: each review is written to a
 * file for the user to read and post. Nothing is posted without them.
 */

import { ASK_FIRST, gateLine } from "./approvals";
import type { Approvals } from "./config";
import { CHECK_REVIEW_QUEUE } from "./collectors/github";
import type { TodayItem } from "./store";

type QueueItem = Pick<TodayItem, "key" | "title" | "url">;

export interface ReviewQueuePlan {
  project: string;
  /** Open reviews without a session: the queue's to work. */
  queued: TodayItem[];
  /** Open reviews another session already works: left out of the queue. */
  taken: TodayItem[];
}

/**
 * The open reviews grouped by project, keeping only the projects with something left to queue.
 * `project` narrows it to one.
 */
export function planReviewQueues(items: TodayItem[], project?: string): ReviewQueuePlan[] {
  const open = items.filter(
    (item) =>
      item.section === "review" && item.status === "open" && (!project || item.project === project),
  );
  const projects = [...new Set(open.map((item) => item.project))];
  return projects
    .map((name) => {
      const mine = open.filter((item) => item.project === name);
      return {
        project: name,
        queued: mine.filter((item) => !item.sessionId),
        taken: mine.filter((item) => item.sessionId),
      };
    })
    .filter((plan) => plan.queued.length > 0);
}

/** "Review queue · app" */
export function reviewQueueTitle(project: string): string {
  return `Review queue · ${project}`;
}

function line(item: QueueItem): string {
  return `- ${item.title} (board key \`${item.key}\`)${item.url ? `\n  ${item.url}` : ""}`;
}

/** The repos a queue covers, from its review keys (`review:<owner>/<repo>#<n>`). */
export function queueRepos(items: QueueItem[]): string[] {
  const repos = items.map((item) => item.key.match(/^review:(.+)#\d+$/)?.[1]);
  return [...new Set(repos.filter((repo): repo is string => Boolean(repo)))].sort();
}

export function reviewQueuePrompt(plan: {
  queued: QueueItem[];
  taken: QueueItem[];
  context?: string;
  approvals?: Approvals;
}): string {
  const note = plan.context?.trim();
  const approvals = plan.approvals ?? ASK_FIRST;
  const listing = queueRepos(plan.queued)
    .map((repo) => `\`${CHECK_REVIEW_QUEUE} --json -R ${repo}\``)
    .join(", ");
  return [
    `From my Today board: run my review queue. ${plan.queued.length} PR${plan.queued.length === 1 ? "" : "s"} waiting on me right now:`,
    plan.queued.map(line).join("\n"),
    note &&
      `My note before you start (it comes first, even where it changes what the steps below say):\n${note}`,
    `Work through them one PR (or one stack, bottom first) at a time. The live queue is the source of truth (${listing || `\`${CHECK_REVIEW_QUEUE} --json\``}); the list above is only what my board showed when I clicked. Pick the order (follow-ups and re-requests first), keep the plan in tmp/reviews/QUEUE.md, and when your context gets heavy, hand off (\`anima session handoff\`) with the queue file named in the handoff prompt. If the running-review-sessions skill is installed, it has the details; where it differs from this prompt, this prompt wins.`,
    approvals.post
      ? "Draft each review in tmp/reviews/<number>.md (your verdict, a short summary, each inline comment with its file and line) and post none of them. When the queue is drafted, or before you hand off, ask me once on the board with the first PR's key, listing the drafts, and I'll post them myself or tell you to."
      : "Post each verdict yourself unless there's a question for me.",
    plan.taken.length > 0 &&
      `These already have their own session, so leave them out of the queue:\n${plan.taken.map(line).join("\n")}`,
    "If tmp/reviews/QUEUE.md still has pending rows from an earlier queue, don't ask me whether to resume: fold this run into it, reconciling against the live queue.",
    gateLine(approvals),
    `To ask me something, run \`anima today ask --key '<the PR's board key>' --question "<the question>"\`, then end your turn with the same question.`,
    "The board links every PR above to this session and follows each handoff, so the queue shows as working on my board until the reviews are posted.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
