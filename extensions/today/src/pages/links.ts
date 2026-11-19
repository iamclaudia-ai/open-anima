/**
 * Links out of the Today page: PR and ticket references in the agent's notes and
 * reasons ("#123 is approved", "ENG-101 is off your plate") become links,
 * and each item's session reads as what it's doing right now. Pure, so it's testable.
 */

import type { Item, Tone } from "./model";

export type TextPart = string | { text: string; url: string };

// "#123" (3+ digits, so "#1 priority" stays text) or a ticket id like "ENG-101".
const REF = /#(\d{3,})\b|\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
const PR_KEY = /^(?:pr|review):([^#]+)#(\d+)$/;
const LINEAR_BASE = /^(https:\/\/linear\.app\/[^/]+\/issue\/)/;

export interface RefLinker {
  (text: string): TextPart[];
}

/**
 * Split text into plain runs and links, resolved from the board. A ref on the board links to its
 * item. One that isn't (merged yesterday, say) is built from what the board knows: a PR number in
 * the repo most of your PRs live in, a ticket only for a team whose tickets are on the board (so
 * "UTF-8" stays text).
 */
export function refLinker(items: Pick<Item, "key" | "url">[]): RefLinker {
  const prs = new Map<string, string>();
  const tickets = new Map<string, string>();
  const repos = new Map<string, number>();
  const teams = new Set<string>();
  let linearBase: string | null = null;

  for (const { key, url } of items) {
    if (!url) continue;
    const pr = key.match(PR_KEY);
    if (pr?.[1] && pr[2]) {
      prs.set(pr[2], url);
      repos.set(pr[1], (repos.get(pr[1]) ?? 0) + 1);
      continue;
    }
    if (key.startsWith("linear:")) {
      const id = key.slice("linear:".length);
      tickets.set(id, url);
      teams.add(id.replace(/-\d+$/, ""));
      linearBase ??= url.match(LINEAR_BASE)?.[1] ?? null;
    }
  }
  const repo = [...repos].sort((a, b) => b[1] - a[1])[0]?.[0];

  const resolve = (pr: string | undefined, ticket: string | undefined): string | null => {
    if (pr) return prs.get(pr) ?? (repo ? `https://github.com/${repo}/pull/${pr}` : null);
    if (!ticket) return null;
    const known = tickets.get(ticket);
    if (known) return known;
    const team = ticket.replace(/-\d+$/, "");
    return linearBase && teams.has(team) ? `${linearBase}${ticket}` : null;
  };

  return (text) => {
    const parts: TextPart[] = [];
    let last = 0;
    for (const match of text.matchAll(REF)) {
      const url = resolve(match[1], match[2]);
      if (!url) continue;
      if (match.index > last) parts.push(text.slice(last, match.index));
      parts.push({ text: match[0], url });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
}

/** The bits of a live session (`session.list_attention`) the pill reads. */
export interface SessionSnapshot {
  runtimeStatus: string;
  disposition?: string;
  worktreeSetup?: { state: "running" | "failed" };
}

export interface SessionState {
  label: string;
  tone: Tone;
  /** Spin the icon: something is happening that needs nobody. */
  busy: boolean;
}

/**
 * What an item's session is doing, for the pill that links to it. A question it asked wins. A session missing from the
 * attention queue has been marked done (or archived): still linked, just quiet. One still in the
 * queue with no turn running has said its piece and waits on you: a turn settles to `idle`, then
 * `stalled` once the pane goes quiet, and rarely to `completed`.
 */
export function sessionState(
  session: SessionSnapshot | undefined,
  /** The item carries an unanswered question from this session (`today.ask`). */
  asked = false,
): SessionState {
  if (session?.worktreeSetup?.state === "failed") {
    return { label: "Setup failed", tone: "red", busy: false };
  }
  if (asked) return { label: "Needs you", tone: "purple", busy: false };
  if (!session) return { label: "Session", tone: "gray", busy: false };
  const { runtimeStatus, disposition, worktreeSetup } = session;
  if (worktreeSetup?.state === "running") return { label: "Setting up", tone: "amber", busy: true };
  if (
    runtimeStatus === "awaiting_input" ||
    runtimeStatus === "awaiting_approval" ||
    runtimeStatus === "api_error" ||
    disposition === "blocked"
  ) {
    return { label: "Needs you", tone: "red", busy: false };
  }
  if (runtimeStatus === "running") return { label: "Working", tone: "blue", busy: true };
  if (runtimeStatus === "failed") return { label: "Failed", tone: "red", busy: false };
  if (disposition === "needs_review") return { label: "Review it", tone: "green", busy: false };
  return { label: "Your turn", tone: "green", busy: false };
}
