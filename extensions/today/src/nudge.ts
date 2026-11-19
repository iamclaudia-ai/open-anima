/**
 * Today — nudging reviewers: when one of your PRs has waited on review for a few days, the board
 * says a nudge is due and drafts one. You post it yourself: the Nudge button copies the draft to
 * your clipboard and records that you nudged, so the board can count the days since. Nothing is
 * ever posted for you (docs/HUMAN-IN-THE-LOOP.md). Pure, shared by the server and page.
 */

interface NudgeItem {
  section: string;
  status: string;
  title: string;
  url: string | null;
  meta: Record<string, unknown> | null;
}

/** PR states (`prState`) that wait on a reviewer's review: a first one, a re-review, an engineer's. */
const ON_REVIEWERS = new Set(["awaiting_review", "re_review", "needs_engineer"]);

/** Your own open PR, waiting on reviewers (not a draft, nothing to fix first). */
export function canNudge(item: NudgeItem): boolean {
  return (
    item.section === "my_pr" &&
    item.status === "open" &&
    Boolean(item.url) &&
    ON_REVIEWERS.has(String(item.meta?.state))
  );
}

/** Calendar days a nudge gets to work before the PR may be a top pick again (Friday → Monday). */
export const NUDGE_QUIET_DAYS = 3;

/** A time's local date, as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local date `days` after an ISO time's, as YYYY-MM-DD. */
function localDatePlus(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** Since when it has waited: its state's start, or your last nudge if that came later. */
export function waitingSince(item: {
  stateSince: string | null;
  nudgedAt: string | null;
}): string | null {
  const { stateSince, nudgedAt } = item;
  if (!stateSince || !nudgedAt) return nudgedAt ?? stateSince;
  return Date.parse(nudgedAt) > Date.parse(stateSince) ? nudgedAt : stateSince;
}

/**
 * Waiting on reviewers for `NUDGE_QUIET_DAYS` calendar days or more (since the state began, or
 * since your last nudge): a nudge is your move now, so it counts as something to do.
 */
export function nudgeDue(
  item: NudgeItem & { nudgedAt: string | null; stateSince: string | null },
  today: string,
): boolean {
  const since = waitingSince(item);
  return canNudge(item) && since !== null && today >= localDatePlus(since, NUDGE_QUIET_DAYS);
}

/**
 * Nudged recently and still waiting on review: there's nothing to do but wait, so it
 * isn't a top pick until `NUDGE_QUIET_DAYS` calendar days after the nudge. `today` is the
 * board's local date (YYYY-MM-DD).
 */
export function nudgeQuiet(item: NudgeItem & { nudgedAt: string | null }, today: string): boolean {
  return (
    canNudge(item) &&
    item.nudgedAt !== null &&
    today < localDatePlus(item.nudgedAt, NUDGE_QUIET_DAYS)
  );
}

/** The drafted nudge, as Markdown to paste: `Could someone review this? [fix: ENG-1 the title](https://github.com/…/pull/1)` */
export function nudgeMessage(item: Pick<NudgeItem, "title" | "url">): string {
  // The board's title leads with "#123 "; the message uses the PR's own title.
  const title = item.title.replace(/^#\d+\s+/, "");
  return `Could someone review this? [${title}](${item.url})`;
}
