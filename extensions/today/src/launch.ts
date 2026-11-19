/**
 * Today — what a session started from an item's Start button is told, and where it starts.
 *
 * The prompt reads as the user's own ask: what the item is, why it's on the board, what to do
 * about it, where to stop and ask (approvals.ts), and how the item closes when the work is done.
 */

import { ASK_FIRST, gateLine } from "./approvals";
import type { Approvals, ProjectConfig } from "./config";
import { reviewStackOf } from "./stacks";
import type { Section, TodayItem } from "./store";

/** How a review ends: a draft for the user to post (the default), or a posted verdict. */
function reviewAsk(approvals: Approvals): string {
  return approvals.post
    ? "Please review this PR in full and draft the review: your verdict (approve, comment or request changes), a short summary, and each inline comment with its file and line. Don't post it: when the draft is ready, ask me on the board, and I'll post it myself or tell you to."
    : "Please review this PR in full and post your verdict, and only ping me if there's a real question for me.";
}

/** AI review bots' threads are ours to settle; a person's thread we answered waits on them. */
export const BOT_THREADS =
  "Treat AI reviewers' threads (CodeRabbit and the like) as ours to settle: fix what's real, and for the rest reply with why not and resolve the thread. A thread a person opened that we already answered waits on them; leave it to them.";

function ask(section: Section, approvals: Approvals): string {
  switch (section) {
    case "review":
      return reviewAsk(approvals);
    case "my_pr":
      return `This is one of our PRs. Please get it moving: address review feedback and open review threads, fix CI, resolve conflicts, and once it's approved with no open feedback, get it merged. ${BOT_THREADS}`;
    case "ticket":
      return "Please work this ticket. Read it in full first, then do the work on a branch, with tests, up to a PR. If it isn't ours to code, tell me what it needs instead.";
    case "promise":
      return "This is something I promised someone. Read the thread or note it links to, then do what it needs and draft any reply for me, or tell me what's still needed to close it out.";
    // Always started for its whole app (see `promoteStackPrompt`); this is the fallback.
    case "promote":
      return "This PR of ours is merged, but production doesn't have it yet. Please get it ready to ship: find its app's promote, and tell me what would go out with it.";
  }
}

const VERB: Record<Section, string> = {
  review: "Review",
  my_pr: "Land",
  ticket: "Work",
  promise: "Keep promise",
  promote: "Ship",
};

type LaunchItem = Pick<TodayItem, "section" | "title" | "key" | "meta">;

/** Session name: "Review: #123 Fix the login redirect…" */
export function launchTitle(item: Pick<TodayItem, "section" | "title">): string {
  return `${VERB[item.section]}: ${item.title}`.slice(0, 200);
}

/** "#123 Fix…" → { id: "#123", text: "Fix…" }; "ENG-1 Do it" → { id: "ENG-1", … }. */
function splitId(title: string): { id: string | null; text: string } {
  const match = title.match(/^(#\d+|[A-Z][A-Z0-9]*-\d+)\s+(.*)$/);
  return { id: match?.[1] ?? null, text: match?.[2] ?? title };
}

/** Lowercase words joined by hyphens, cut at a word boundary. */
function slug(text: string, max = 40): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  let out = "";
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || "item";
}

/**
 * The worktree branch an item's session works on. Our own PRs reuse their branch so pushes
 * land on the PR; everything else gets a fresh branch under the project's prefix.
 */
export function launchBranch(item: LaunchItem, prefix: string): string {
  const { id, text } = splitId(item.title);
  switch (item.section) {
    case "my_pr": {
      const branch = item.meta?.branch;
      if (typeof branch !== "string" || !branch) {
        throw new Error(`${item.key} has no branch yet; refresh the board and try again`);
      }
      return branch;
    }
    case "review":
      return `${prefix}review-${id ? id.slice(1) : slug(text)}`;
    case "ticket":
      return id ? `${prefix}${slug(text)}-${id}` : `${prefix}${slug(text)}`;
    case "promise":
      return `${prefix}promise-${slug(text)}`;
    case "promote":
      // Never used: shipping changes no code, so it starts in the main checkout.
      return `${prefix}promote-${slug(text)}`;
  }
}

/** Where the session starts: the main checkout, or its own worktree when the project asks for one. */
export function launchFolder(
  item: LaunchItem,
  project: Pick<ProjectConfig, "cwd" | "worktree">,
): { cwd: string; worktree?: string } {
  // Shipping changes no code: the main checkout is all it needs.
  if (!project.worktree || item.section === "promote") return { cwd: project.cwd };
  return { cwd: project.cwd, worktree: launchBranch(item, project.worktree.branchPrefix) };
}

/** Without it, a question at the end of a turn looks exactly like "done" on the board. */
export function askLine(key: string): string {
  return `When you need me (a go for one of the steps above, a decision, a clarification, a draft to read), don't just end your turn with the question. Run \`anima today ask --key '${key}' --question "<the question>"\` first: it puts the question on my board and pings me. Then end your turn with the same question. It clears itself when I reply. When you're simply done, just say so.`;
}

/**
 * Without it, a session that finished (fixes pushed, now waiting on a reviewer) sits in the
 * user's Active list until they read it to find out. The board also marks a session done by
 * itself once every item it works closes.
 */
export const FINISH =
  "When you've done everything you can and nothing waits on me (the fixes I said go for are pushed and waiting on a reviewer, the PR merged, the review posted), end with a short summary and mark this session done: `anima session set_status --sessionId \"$ANIMA_SESSION_ID\" --disposition resolved`. It leaves my Active list but stays linked on my board, and a new prompt reopens it. Leave it open when your last message is something for me to read or decide: a question, a draft, a go you're waiting for, or what it still needs from me.";

/**
 * What the user typed in the Start dialog. It goes right after the facts, and it outranks the standing
 * steps below it: "I already did this on Friday, close it as kept" must not end in a redo.
 */
export function noteLine(context?: string): string | null {
  const text = context?.trim();
  return text
    ? `My note before you start (it comes first, even where it changes what the steps below say):\n${text}`
    : null;
}

export function launchPrompt(
  item: TodayItem,
  worktree?: string,
  context?: string,
  approvals: Approvals = ASK_FIRST,
): string {
  const facts = [
    item.url,
    item.topReason && `Why it's a top pick today: ${item.topReason}`,
    item.stateLabel && `State: ${item.stateLabel}`,
    item.waitingOn && `Waiting: ${item.waitingOn}`,
    item.dueDate && `Due: ${item.dueDate}`,
    item.note && `Note: ${item.note}`,
  ].filter(Boolean);

  const prNumber = splitId(item.title).id?.slice(1);
  const where = !worktree
    ? null
    : item.section === "review"
      ? `You're in your own worktree (branch \`${worktree}\`), so sessions I start side by side can't clobber each other. Check the PR out right here (\`gh pr checkout ${prNumber} --detach\`) instead of making another worktree.`
      : `You're in your own worktree on branch \`${worktree}\`, so sessions I start side by side can't clobber each other. Do the work here, not in the main checkout.`;

  return [
    `From my Today board: ${item.title}`,
    facts.join("\n"),
    noteLine(context),
    ask(item.section, approvals),
    where,
    gateLine(approvals),
    askLine(item.key),
    // Collector-owned items close themselves once the source does; a hand-added one never will.
    item.source === "manual"
      ? `When it's done, close it on the board: \`anima today complete --key '${item.key}' --by agent --note "<one line>"\``
      : `The board closes this item by itself once the source does (ticket done, PR merged, review posted, production has the change). If it ends some other way, close it yourself: \`anima today complete --key '${item.key}' --by agent --note "<one line>"\``,
    FINISH,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── Stacks: one session for every PR in a stack ──────────────

type StackItem = Pick<
  TodayItem,
  | "key"
  | "section"
  | "title"
  | "url"
  | "stateLabel"
  | "waitingOn"
  | "topReason"
  | "note"
  | "meta"
  | "sessionId"
  | "sessionStack"
> & { sessionWorkspaceId: string | null };

/** Session name for a stack: "Land stack: #101 Migrate… (+2)", "Review stack: #120 …". */
export function stackTitle(members: Pick<TodayItem, "section" | "title" | "meta">[]): string {
  const first = members[0]!;
  if (first.section === "promote") {
    const prs = members.length === 1 ? "1 PR" : `${members.length} PRs`;
    return `Ship ${String(first.meta?.app)}: ${prs} waiting on its promote`;
  }
  const review = reviewStackOf(first);
  const size = review?.length ?? members.length;
  const verb = first.section === "review" ? "Review stack" : "Land stack";
  return `${verb}: ${first.title}${size > 1 ? ` (+${size - 1})` : ""}`.slice(0, 200);
}

/**
 * Where a stack's session starts: our own stack on its bottom PR's branch; a review stack in a
 * worktree of its own, named for the stack's bottom PR, where it checks the PRs out.
 */
export function stackFolder(
  members: StackItem[],
  project: Pick<ProjectConfig, "cwd" | "worktree">,
): { cwd: string; worktree?: string } {
  const bottom = members[0]!;
  if (bottom.section !== "review") return launchFolder(bottom, project);
  if (!project.worktree) return { cwd: project.cwd };
  const root = reviewStackOf(bottom)?.[0]?.number ?? bottom.meta?.number;
  return { cwd: project.cwd, worktree: `${project.worktree.branchPrefix}review-stack-${root}` };
}

export type StackPlan =
  /** Every PR in it already shares the stack's session. */
  | { kind: "existing"; sessionId: string }
  /** Some PRs have a session: the bottom-most one takes the whole stack. */
  | { kind: "adopt"; session: { sessionId: string; workspaceId: string }; others: string[] }
  /** Nobody has it yet (or a restart): a new session in the bottom PR's worktree. */
  | { kind: "new"; others: string[] };

/** Who works the stack (members bottom first, see `prStacks`). */
export function planStackLaunch(
  members: Array<Pick<StackItem, "sessionId" | "sessionWorkspaceId" | "sessionStack">>,
  restart: boolean,
): StackPlan {
  const sessions = [...new Set(members.map((m) => m.sessionId).filter(Boolean))] as string[];
  if (!restart && sessions.length === 1 && members.every((m) => m.sessionId && m.sessionStack)) {
    return { kind: "existing", sessionId: sessions[0]! };
  }
  // A session that already works the stack wins over one started for a single PR.
  const holder =
    members.find((m) => m.sessionId && m.sessionWorkspaceId && m.sessionStack) ??
    members.find((m) => m.sessionId && m.sessionWorkspaceId);
  if (!restart && holder) {
    const session = { sessionId: holder.sessionId!, workspaceId: holder.sessionWorkspaceId! };
    return { kind: "adopt", session, others: sessions.filter((id) => id !== session.sessionId) };
  }
  return { kind: "new", others: sessions };
}

/**
 * What a stack's session is told: every PR bottom first with its board key, to work them as
 * one stack, and to name the PR in any question so it lands under that PR on the board.
 */
export function stackPrompt(members: StackItem[], options: StackPromptOptions): string {
  const { section } = members[0]!;
  if (section === "promote") return promoteStackPrompt(members, options);
  return section === "review"
    ? reviewStackPrompt(members, options)
    : ownStackPrompt(members, options);
}

/**
 * One app's merged PRs that its production doesn't have yet (collectors/deploys.ts). Running the
 * deploy workflow waits for the user's go (the `deploy` gate), and approving the promote is
 * never the session's call, since other people's merges go out with ours.
 */
function promoteStackPrompt(members: StackItem[], options: StackPromptOptions): string {
  const { app, repo, prodTag, workflow, promoteUrl } = members[0]!.meta as Record<string, string>;
  const list = members
    .map((m, i) =>
      [
        `${i + 1}. ${m.title}`,
        `   ${[m.url, `board key \`${m.key}\``].filter(Boolean).join(" · ")}`,
      ]
        .concat(m.note ? [`   Note: ${m.note}`] : [])
        .join("\n"),
    )
    .join("\n");
  return [
    `From my Today board: ${members.length === 1 ? "a PR of ours is" : `${members.length} of our PRs are`} merged but not in production yet. ${app} (${repo}) is still on \`${prodTag}\`:`,
    list,
    noteLine(options.context),
    `Please get ${members.length === 1 ? "it" : "them"} ready to ship. First see whether a promote of ${app} is already waiting for approval. If there isn't one, look at everything that would go out with it (\`gh api "repos/${repo}/compare/${prodTag}...HEAD"\` lists the commits, other people's merges included) and tell me in a few lines what ships and whether anything looks risky.`,
    options.approvals?.deploy === false
      ? `Then run the deploy workflow (\`gh workflow run ${workflow} -R ${repo}\`, ${promoteUrl}). Never approve a promote yourself. When it's posted, tell me it's waiting for approval, with the link.`
      : `Then ask me on the board before running the deploy workflow (\`gh workflow run ${workflow} -R ${repo}\`, ${promoteUrl}), and run it only once I say go, here or in my note above. Never approve a promote yourself. When it's posted, tell me it's waiting for approval, with the link.`,
    gateLine(options.approvals ?? ASK_FIRST),
    STACK_ASK,
    "The board closes each PR's item by itself once production has it. Another PR of ours that starts waiting on this app joins this same session.",
    FINISH,
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface StackPromptOptions {
  worktree?: string;
  /** The user's note from the Start dialog. */
  context?: string;
  /** What the session asks about first (default: everything). */
  approvals?: Approvals;
  adopted?: boolean;
  others?: string[];
}

const STACK_ASK = `When you need me (a go for one of the steps above, a decision, a clarification, a draft to read), don't just end your turn with the question. Run \`anima today ask --key '<the key of the PR it's about>' --question "<the question>"\` first, with the key from the list above: the question shows under that PR on my board and pings me. Name the PR in the question too. Then end your turn with the same question. It clears itself when I reply. When you're simply done, just say so.`;

const STACK_HANDOFF =
  "If your context gets heavy, hand off (`anima session handoff`) as usual and put this list, with the keys, in the handoff prompt: the board follows the handoff to the new session.";

function othersLine(others: string[] = []): string | null {
  return others.length > 0
    ? `Other sessions worked on PRs in this stack before (${others.join(", ")}). If one of the branches is still checked out in their worktree, \`git worktree list\` shows where; tell me before removing a worktree that has uncommitted changes.`
    : null;
}

/**
 * A teammate's stack waiting on the user's review: every PR in it bottom first (the review
 * queue's `stack`), the ones in their queue with their board keys, the rest as context the
 * session reads but doesn't review.
 */
function reviewStackPrompt(members: StackItem[], options: StackPromptOptions): string {
  const onBoard = new Map(members.map((m) => [m.meta?.number, m]));
  const stack =
    reviewStackOf(members[0]!) ??
    members.map((m) => ({
      number: Number(m.meta?.number),
      title: m.title,
      url: m.url,
      inQueue: true,
    }));
  const list = stack
    .map((pr, i) => {
      const item = onBoard.get(pr.number);
      const title = item?.title ?? `#${pr.number} ${pr.title}`;
      const lines = item
        ? [
            `${i + 1}. ${title} (${item.stateLabel ?? "review requested"}): review this one`,
            `   ${[item.url, `board key \`${item.key}\``].filter(Boolean).join(" · ")}`,
            item.topReason && `   Top pick today: ${item.topReason}`,
            item.note && `   Note: ${item.note}`,
          ]
        : [
            `${i + 1}. ${title}: context only (already approved, or not asked of me)`,
            pr.url && `   ${pr.url}`,
          ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n");
  const top = stack.at(-1)!.number;
  const author = members[0]!.waitingOn;
  const intro = `a stack of ${stack.length} PRs${author ? ` by ${author}` : ""}, bottom first, with ${members.length === 1 ? "one" : members.length} waiting on my review`;

  return [
    options.adopted
      ? `From my Today board: the whole stack is yours now, not just the PR you started on. It's ${intro}:`
      : `From my Today board: ${intro}:`,
    list,
    noteLine(options.context),
    `Please review it as one stack, all in this session, so you know how the layers fit together. Check out the top PR here (\`gh pr checkout ${top} --detach\`) to have every layer, then review each PR marked "review this", bottom first, on its own diff (\`gh pr diff <n>\`) with the layers below it in mind. Read the context-only PRs but don't review them.`,
    options.approvals?.post === false
      ? "Post your verdict on each, and only ping me if there's a real question for me."
      : "Draft a review for each (your verdict, a short summary, each inline comment with its file and line) and post none of them: when the drafts are ready, ask me on the board, and I'll post them myself or tell you to.",
    options.worktree &&
      `You're in your own worktree (branch \`${options.worktree}\`), so sessions I start side by side can't clobber each other. Check the stack out right here instead of making another worktree.`,
    othersLine(options.others),
    gateLine(options.approvals ?? ASK_FIRST),
    STACK_ASK,
    STACK_HANDOFF,
    "The board closes each review by itself once it leaves my queue (the review posted). A PR of this stack that joins my queue later shows up under this same session.",
    FINISH,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Our own stack: get every PR in it moving and merge it bottom first. */
function ownStackPrompt(members: StackItem[], options: StackPromptOptions): string {
  const list = members
    .map((m, i) => {
      const lines = [
        `${i + 1}. ${m.title}${m.stateLabel ? ` (${m.stateLabel})` : ""}`,
        `   ${[m.url, `board key \`${m.key}\``].filter(Boolean).join(" · ")}`,
        m.topReason && `   Top pick today: ${m.topReason}`,
        m.note && `   Note: ${m.note}`,
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n");

  return [
    options.adopted
      ? `From my Today board: the whole stack is yours now, not just the PR you started on. ${members.length} of our PRs, bottom first:`
      : `From my Today board: a stack of ${members.length} of our PRs, bottom first:`,
    list,
    noteLine(options.context),
    "Work it as one stack, all in this session: get every PR in it moving (review feedback and open threads, CI, conflicts) and get what's approved merged, bottom first. You pick the order. If gh-stack is installed (the using-gh-stack skill covers it), use it: restack the PRs above one you change, and `gh-stack sync` after a merge.",
    BOT_THREADS,
    options.worktree &&
      `You're in your own worktree on the bottom PR's branch \`${options.worktree}\`. Switch between the stack's branches right here (\`gh-stack up\` / \`down\`), not in another worktree, so nothing else touches them.`,
    othersLine(options.others),
    gateLine(options.approvals ?? ASK_FIRST),
    STACK_ASK,
    STACK_HANDOFF,
    "The board closes each PR's item by itself when it merges. A PR you add to the stack shows up on the board under this same session.",
    FINISH,
  ]
    .filter(Boolean)
    .join("\n\n");
}
