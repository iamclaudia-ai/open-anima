/**
 * Today — the human checkpoint in every prompt the board sends a session (docs/HUMAN-IN-THE-LOOP.md).
 *
 * A session started from the board does the work on this machine (reads, edits, commits, runs
 * tests) and then stops before anything leaves it or becomes permanent: a push, a merge, a post,
 * a deploy. It prepares that step, asks you on the board (`anima today ask`), and waits for your
 * go. Which steps ask is config (`approvals`, every one on by default), so a team can loosen a
 * gate on purpose once it trusts how its sessions handle it. Pure.
 */

import type { Approvals } from "./config";

/** The safe default: every gate asks. */
export const ASK_FIRST: Approvals = { push: true, merge: true, post: true, deploy: true };

/** The steps a gate covers, in the words the session reads. */
const STEPS: Record<keyof Approvals, string> = {
  push: "push a branch or open or update a PR",
  merge: "approve or merge a PR",
  post: "post anything other people see (a review, a PR comment or reply, resolving someone's thread, a re-review request, a chat message)",
  deploy: "deploy, promote, or run a release workflow",
};

/**
 * The line every prompt carries: what to stop and ask about first, and how. Null when every
 * gate is off (a team that chose full autonomy).
 */
export function gateLine(approvals: Approvals): string | null {
  const gated = (Object.keys(STEPS) as Array<keyof Approvals>).filter((step) => approvals[step]);
  if (gated.length === 0) return null;
  const steps = gated.map((step) => STEPS[step]).join("; ");
  return `Stop and ask me before you ${gated.length === 1 ? steps : `do any of these: ${steps}`}. Get it ready first (the commits, the draft text, the exact command), tell me what you're about to do and why, ask me on the board as described below, and wait for my go. A go covers what I said yes to, nothing more.`;
}
