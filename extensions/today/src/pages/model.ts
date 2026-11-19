/**
 * Today page model: what each item's urgency is, how a category ranks its
 * items, which lane each item is in right now (yours to do, being worked, waiting
 * on someone), and the short titles the overview shows. Pure, so it's testable.
 */

import { localDate, nudgeDue, waitingSince } from "../nudge";
import { snoozedUntil, snoozeText } from "../snooze";

export type Section = "promise" | "review" | "my_pr" | "ticket" | "promote";

export interface Item {
  id: number;
  key: string;
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
  status: "open" | "done" | "dismissed";
  doneBy: "user" | "agent" | "collector" | null;
  completedAt: string | null;
  pinned: boolean;
  topDate: string | null;
  topRank: number | null;
  topReason: string | null;
  /** When the morning's queue (or a re-rank) set it: its reason holds until its state changes. */
  topAt: string | null;
  sessionId: string | null;
  sessionWorkspaceId: string | null;
  /** Its session works the item's whole PR stack. */
  sessionStack: boolean;
  /** A question its session asked you (`today.ask`), until you answer. */
  question: string | null;
  askedAt: string | null;
  /** When you last nudged reviewers about this PR (`today.nudge`). */
  nudgedAt: string | null;
  /** When its state last changed: how long it has waited on someone. */
  stateSince: string | null;
}

export interface Collection {
  at: string;
  ok: boolean;
  error?: string;
}

export interface ListResponse {
  date: string;
  note: string | null;
  /** When the note was last written: the morning sweep, or a refresh after the picks get done */
  noteUpdatedAt: string | null;
  items: Item[];
  collections: Record<string, Collection>;
  /** GitHub collection waiting for the hour's GraphQL budget to refill. */
  githubPaused?: { until: string; remaining: number } | null;
}

export type Tone = "red" | "amber" | "green" | "blue" | "purple" | "gray";

export interface Flag {
  tone: Tone;
  text: string;
  /** Higher sorts first within a category. */
  weight: number;
}

const DAY = 86_400_000;

/** Days from `today` (local midnight) to a YYYY-MM-DD date; negative = past. */
export function daysUntil(due: string, today: Date = new Date()): number {
  const [y, m, d] = due.split("-").map(Number);
  const target = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime();
  const midnight = new Date(today);
  midnight.setHours(0, 0, 0, 0);
  return Math.round((target - midnight.getTime()) / DAY);
}

export function ageDays(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY));
}

export function ageText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "today";
  if (days < 14) return `${days}d`;
  if (days < 70) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function dueFlag(due: string, now: Date): Flag | null {
  const days = daysUntil(due, now);
  if (days < 0) return { tone: "red", text: `overdue ${-days}d`, weight: 100 - days };
  if (days === 0) return { tone: "red", text: "due today", weight: 95 };
  if (days === 1) return { tone: "amber", text: "due tomorrow", weight: 85 };
  if (days <= 7) return { tone: "amber", text: `due in ${days}d`, weight: 80 - days };
  return null;
}

/** Flag tone and rank for each actionable PR state (`prState` in the github collector). */
const PR_TONES: Record<string, Pick<Flag, "tone" | "weight">> = {
  checks_failing: { tone: "red", weight: 70 },
  changes_requested: { tone: "red", weight: 70 },
  ready: { tone: "green", weight: 65 },
  your_turn: { tone: "blue", weight: 62 },
  conflicts: { tone: "amber", weight: 60 },
  open_comments: { tone: "amber", weight: 58 },
  re_request: { tone: "blue", weight: 50 },
};

/** The single most important thing to say about an item, if anything. */
export function flagFor(item: Item, now: Date = new Date()): Flag | null {
  // Snoozed: out of the way until then, whatever else is true of it.
  const snoozed = snoozedUntil(item, now);
  if (snoozed) return { tone: "gray", text: snoozeText(snoozed), weight: -1 };
  const due = item.dueDate ? dueFlag(item.dueDate, now) : null;
  if (due && due.tone === "red") return due;
  // Under way: its PR is what's waiting now, so no "waiting 4mo" or priority flags here.
  if (inFlight(item)) return null;
  const age = ageDays(item.since, now) ?? 0;

  switch (item.section) {
    case "my_pr": {
      if (nudgeDue(item, localDate(now))) {
        const waited = ageText(ageDays(waitingSince(item), now));
        return { tone: "amber", text: `nudge due · ${waited}`, weight: 45 };
      }
      // Only PRs a session can move get a flag; the rest wait on someone else.
      if (item.meta?.actionable !== true) return null;
      const tone = PR_TONES[String(item.meta?.state)] ?? { tone: "amber", weight: 55 };
      return { ...tone, text: item.stateLabel ?? "needs work" };
    }
    case "review":
      if (item.stateLabel && item.stateLabel !== "review requested")
        return { tone: "blue", text: item.stateLabel, weight: 55 + age };
      if (age >= 3) return { tone: "amber", text: `waiting ${ageText(age)}`, weight: 50 + age };
      return null;
    case "promise":
      if (due) return due;
      if (age >= 7) return { tone: "amber", text: `waiting ${ageText(age)}`, weight: 40 + age / 7 };
      return null;
    case "ticket": {
      if (due) return due;
      const priority = item.meta?.priority;
      if (priority === 1) return { tone: "red", text: "urgent", weight: 75 };
      if (priority === 2) return { tone: "amber", text: "high", weight: 40 };
      if (inCurrentPhase(item)) {
        return {
          tone: "purple",
          text: `phase ${phaseLabel(String(item.meta?.milestone))}`,
          weight: 38,
        };
      }
      return null;
    }
    case "promote":
      // Merged, not in production (collectors/deploys.ts): amber once it has waited 3 days.
      return {
        tone: age >= 3 ? "amber" : "purple",
        text: `${item.stateLabel ?? "not in prod"}${age >= 1 ? ` · ${ageText(age)}` : ""}`,
        weight: 52 + Math.min(age, 14) / 2,
      };
    default:
      return due;
  }
}

/**
 * A ticket or promise already under way (Linear In Progress, In Review, QA). Its PR
 * carries it now: the PR section is where it moves, so it never headlines here.
 * The morning sweep moves a started ticket with no open PR back to Todo.
 */
export function inFlight(item: Item): boolean {
  return (
    (item.section === "ticket" || item.section === "promise") && item.meta?.stateType === "started"
  );
}

/** A ticket in an active project's current phase (Linear favorites and milestones, see linear.ts). */
export function inCurrentPhase(item: Item): boolean {
  return item.section === "ticket" && item.meta?.currentPhase === true;
}

/** A milestone's short name: "2" for "2: Build", else the whole name. */
export function phaseLabel(milestone: string): string {
  return milestone.match(/^([\w.-]+):/)?.[1] ?? milestone;
}

/** An open item whose session asked you something: it goes first, everywhere. */
export function asking(item: Item): boolean {
  return item.status === "open" && Boolean(item.question);
}

/**
 * The items a category headlines. PRs: only the ones a session can act on now.
 * Promises and tickets: only what you can start; tickets also have to be
 * due within a week, urgent/high, or in an active project's current phase
 * (there are hundreds in Todo).
 */
export function needsAttention(item: Item, now: Date = new Date()): boolean {
  if (asking(item)) return true;
  if (snoozedUntil(item, now)) return false;
  if (item.section === "my_pr") return item.meta?.actionable === true;
  if (inFlight(item)) return false;
  if (item.section === "ticket") {
    if (item.dueDate && daysUntil(item.dueDate, now) <= 7) return true;
    const priority = item.meta?.priority;
    return priority === 1 || priority === 2 || inCurrentPhase(item);
  }
  return true;
}

/** Questions for you first, then most urgent, then oldest. */
export function rank(items: Item[], now: Date = new Date()): Item[] {
  return [...items].sort((a, b) => {
    if (asking(a) !== asking(b)) return asking(a) ? -1 : 1;
    const fa = flagFor(a, now)?.weight ?? 0;
    const fb = flagFor(b, now)?.weight ?? 0;
    if (fa !== fb) return fb - fa;
    return (a.since ?? "").localeCompare(b.since ?? "");
  });
}

/**
 * One short line: the identifier, then the title without conventional-commit
 * prefixes or bracketed ticket refs ("#123 add CSV export to the reports page…").
 */
export function shortTitle(item: Pick<Item, "title">): { id: string | null; text: string } {
  const match = item.title.match(/^(#\d+|[A-Z][A-Z0-9]*-\d+)\s+(.*)$/);
  const id = match?.[1] ?? null;
  let text = match?.[2] ?? item.title;
  text = text
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    .replace(/\s*\[[A-Z][A-Z0-9]*-\d+\]\s*/g, " ")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
  return { id, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

export interface SectionInfo {
  section: Section;
  slug: string;
  label: string;
  emoji: string;
  /** Tile wash and accent */
  tint: string;
  accent: string;
}

export const SECTIONS: SectionInfo[] = [
  {
    section: "promise",
    slug: "promises",
    label: "Promises",
    emoji: "🤝",
    tint: "#fde8e4",
    accent: "#c2410c",
  },
  {
    section: "review",
    slug: "reviews",
    label: "Reviews",
    emoji: "👀",
    tint: "#e4f0fd",
    accent: "#1d4ed8",
  },
  {
    section: "my_pr",
    slug: "prs",
    label: "Your PRs",
    emoji: "🚀",
    tint: "#e6f6ec",
    accent: "#15803d",
  },
  {
    section: "ticket",
    slug: "tickets",
    label: "Tickets",
    emoji: "🎫",
    tint: "#f3eafd",
    accent: "#7e22ce",
  },
  {
    section: "promote",
    slug: "promote",
    label: "Ready to promote",
    emoji: "🚢",
    tint: "#dff4f1",
    accent: "#0f766e",
  },
];

export function sectionBySlug(slug: string | undefined): SectionInfo | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}

export interface SectionSummary {
  info: SectionInfo;
  /** Open items in the category */
  total: number;
  /** The ones the overview headlines (needsAttention), ranked */
  headline: Item[];
  counts: { red: number; amber: number; waiting: number; green: number };
}

export function summarize(items: Item[], now: Date = new Date()): SectionSummary[] {
  const open = items.filter((i) => i.status === "open");
  return SECTIONS.map((info) => {
    const all = open.filter((i) => i.section === info.section);
    const headline = rank(
      all.filter((i) => needsAttention(i, now)),
      now,
    );
    const counts = { red: 0, amber: 0, waiting: 0, green: 0 };
    for (const item of headline) {
      if (asking(item)) {
        counts.red++;
        continue;
      }
      const flag = flagFor(item, now);
      if (!flag) continue;
      // Amber means two things: due soon, or someone has waited a while.
      if (flag.tone === "amber" && flag.text.startsWith("waiting")) counts.waiting++;
      else if (flag.tone === "red" || flag.tone === "amber" || flag.tone === "green")
        counts[flag.tone]++;
    }
    return { info, total: all.length, headline, counts };
  });
}

// ── Lanes: where each item stands right now ──────────────────

/**
 * Where an open item stands right now, read from its sources (never from a checkbox):
 * - asking: its session asked you something (the "Needs your answer" list)
 * - working: its session is still in your Active list
 * - actionable: your move (a PR a session can move, a nudge that's due, a review, a ticket or
 *   promise you can start, a promote)
 * - waiting: your PR waits on someone else (reviewers, CI, the PR under it)
 * - idle: none of those (a draft you parked, a ticket its PR carries)
 */
export type Lane = "asking" | "working" | "actionable" | "waiting" | "idle";

const LANE_ORDER: Lane[] = ["asking", "working", "actionable", "waiting", "idle"];

export interface BoardContext {
  /** The board's local date (YYYY-MM-DD): picks and nudges count in calendar days. */
  date: string;
  now: Date;
  /** Sessions still in your Active list; one marked done has left it. */
  live: { has(id: string): boolean };
  /** The open PR stack an item is in, bottom first; null when it stands alone. */
  stackOf(item: Item): Item[] | null;
}

export function itemLane(item: Item, ctx: BoardContext): Lane {
  if (item.status !== "open") return "idle";
  if (asking(item)) return "asking";
  if (item.sessionId && ctx.live.has(item.sessionId)) return "working";
  // Snoozed: neither a pick nor waiting until the date comes (or you unsnooze it).
  if (snoozedUntil(item, ctx.now)) return "idle";
  switch (item.section) {
    case "my_pr":
      if (item.meta?.actionable === true || nudgeDue(item, ctx.date)) return "actionable";
      return item.meta?.state === "draft" ? "idle" : "waiting";
    case "ticket":
    case "promise":
      return inFlight(item) ? "idle" : "actionable";
    default:
      return "actionable";
  }
}

/** One line on the board: an item, or a PR stack judged as a whole. */
export interface Unit {
  /** The item the line shows: the stack's queued or ranked PR, or its bottom one. */
  lead: Item;
  /** Just the lead, or the whole stack bottom first. */
  members: Item[];
  /** The best lane of any member: a stack is actionable when any PR in it is. */
  lane: Lane;
}

export function unitOf(item: Item, ctx: BoardContext): Unit {
  const members = ctx.stackOf(item) ?? [item];
  const best = Math.min(...members.map((m) => LANE_ORDER.indexOf(itemLane(m, ctx))));
  return { lead: item, members, lane: LANE_ORDER[best]! };
}

/** What a waiting item waits on, and for how long: "re-review: sam · 2d". */
export function waitingFlag(item: Item, now: Date = new Date()): Flag {
  const label = item.stateLabel ?? "waiting";
  const who = item.waitingOn && !label.includes(item.waitingOn) ? ` (${item.waitingOn})` : "";
  const age = ageText(ageDays(waitingSince(item), now));
  return { tone: "blue", text: `${label}${who}${age ? ` · ${age}` : ""}`, weight: 0 };
}

/**
 * For a stack, what each PR in it needs right now, so its line says what's actually to do
 * ("#104 1 check failing", "#103 1 review comment") rather than the lead PR's state.
 * A waiting stack lists what each PR waits on instead. Empty for an item on its own.
 */
export function stackFlags(unit: Unit, ctx: BoardContext): Flag[] {
  // An app's PRs ready to promote: one line for the app, its oldest wait deciding the tone.
  if (unit.lead.section === "promote") return [promoteFlag(unit.members, ctx.now)];
  if (unit.members.length < 2) return [];
  const wanted: Lane = unit.lane === "waiting" ? "waiting" : "actionable";
  return unit.members.flatMap((m) => {
    if (itemLane(m, ctx) !== wanted) return [];
    const flag = wanted === "waiting" ? waitingFlag(m, ctx.now) : flagFor(m, ctx.now);
    return flag ? [{ ...flag, text: `#${String(m.meta?.number)} ${flag.text}` }] : [];
  });
}

/** "web · 3 PRs · 12d" for one app's PRs ready to promote (oldest merge first). */
export function promoteFlag(members: Item[], now: Date = new Date()): Flag {
  const oldest = flagFor(members[0]!, now);
  const age = ageText(ageDays(members[0]!.since, now));
  const prs = members.length === 1 ? "1 PR" : `${members.length} PRs`;
  return {
    tone: oldest?.tone ?? "purple",
    text: [String(members[0]!.meta?.app), prs, age].filter(Boolean).join(" · "),
    weight: oldest?.weight ?? 52,
  };
}

/** A due nudge as a pick's reason: "Nudge jordan, casey: no review since Nov 10". */
export function nudgeReason(item: Item): string {
  const label = item.stateLabel ?? "";
  const who =
    item.waitingOn ?? (label.startsWith("re-review: ") ? label.slice(11) : "the reviewers");
  const since = waitingSince(item);
  if (!since) return `Nudge ${who}`;
  const day = new Date(since).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return since === item.nudgedAt
    ? `Nudge ${who} again: nothing since your nudge on ${day}`
    : `Nudge ${who}: no review since ${day}`;
}

/**
 * The queue's reason for a pick, while it's still true: once the item's state (or any PR's in its
 * stack) changes after it was queued, the reason describes a board that's gone, so its flags speak
 * instead. Null when it isn't today's pick.
 */
export function liveReason(unit: Unit, date: string): string | null {
  const { lead } = unit;
  if (lead.topDate !== date || !lead.topReason) return null;
  const queued = lead.topAt ? Date.parse(lead.topAt) : null;
  if (queued === null) return lead.topReason;
  const moved = unit.members.some((m) => m.stateSince && Date.parse(m.stateSince) > queued);
  return moved ? null : lead.topReason;
}

/** How many picks the board shows. */
export const TOP_PICKS = 5;

const MOVING: Lane[] = ["working", "actionable"];

/** The morning's queue order: today's ranked picks, then pins. */
function queueOrder(item: Item, date: string): number {
  return item.topDate === date ? (item.topRank ?? 50) : 1000;
}

/**
 * The live picks: the morning's ranked queue (today's `topRank`, then pins), keeping what's yours
 * to act on or being worked right now, up to `max`. Anything that starts waiting leaves and the
 * next one moves up; when the queue runs out, the board's own ranking fills the rest, so it
 * never sits short while there's work. A stack takes one place. Questions for you aren't here:
 * they have their own list above.
 *
 * Reviews never take a place: the review page clears them all in one click. And the last place
 * goes to a ticket from an active project's current phase when none made it in by itself, so the
 * project work never gets crowded out by promises and backlog.
 */
export function topPicks(items: Item[], ctx: BoardContext, max = TOP_PICKS): Unit[] {
  const open = items.filter((i) => i.status === "open" && i.section !== "review");
  const queue = open
    .filter((i) => i.topDate === ctx.date || i.pinned)
    .sort((a, b) => queueOrder(a, ctx.date) - queueOrder(b, ctx.date));
  const fallback = rank(
    open.filter(
      (i) => itemLane(i, ctx) === "working" || needsAttention(i, ctx.now) || nudgeDue(i, ctx.date),
    ),
    ctx.now,
  );
  const phasePick = [...queue, ...fallback].find(
    (i) => inCurrentPhase(i) && MOVING.includes(itemLane(i, ctx)),
  );
  const picks: Unit[] = [];
  const seen = new Set<number>();
  for (const item of [...queue, ...fallback]) {
    if (picks.length >= max) break;
    if (seen.has(item.id)) continue;
    const unit = unitOf(item, ctx);
    if (!MOVING.includes(unit.lane)) continue;
    const last = picks.length === max - 1;
    if (
      last &&
      phasePick &&
      !seen.has(phasePick.id) &&
      !picks.some((u) => inCurrentPhase(u.lead))
    ) {
      picks.push(unitOf(phasePick, ctx));
      break;
    }
    for (const member of unit.members) seen.add(member.id);
    picks.push(unit);
  }
  return picks;
}

/** Where an active project stands: its current phase, what's left in it, and what comes after. */
export interface PhaseLine {
  project: string;
  /** The current milestone's name; null when none of your open tickets in it has one. */
  phase: string | null;
  /** Your open tickets in the current phase (started ones too). */
  left: number;
  /** Later milestones that still hold your tickets, in order, short names ("5", "7", "9"). */
  later: string[];
  /** Your open tickets in the project that aren't in any milestone. */
  unphased: number;
}

/**
 * One line per active project, from the tickets' Linear meta (see linear.ts): the ones with a
 * phase first, the most work left leading.
 */
export function phaseLines(items: Item[]): PhaseLine[] {
  const byProject = new Map<string, Item[]>();
  for (const item of items) {
    if (item.status !== "open" || item.section !== "ticket" || item.meta?.activeProject !== true) {
      continue;
    }
    const project = String(item.meta?.project ?? item.project);
    byProject.set(project, [...(byProject.get(project) ?? []), item]);
  }
  const lines = [...byProject].map(([project, tickets]): PhaseLine => {
    const current = tickets.filter((t) => t.meta?.currentPhase === true);
    const currentOrder = current[0]?.meta?.milestoneOrder as number | undefined;
    const later = new Map<string, number>();
    for (const t of tickets) {
      const order = t.meta?.milestoneOrder;
      if (typeof order !== "number" || t.meta?.currentPhase === true) continue;
      if (currentOrder !== undefined && order < currentOrder) continue;
      later.set(phaseLabel(String(t.meta?.milestone)), order);
    }
    return {
      project,
      phase: current[0] ? String(current[0].meta?.milestone) : null,
      left: current.length,
      later: [...later].sort((a, b) => a[1] - b[1]).map(([name]) => name),
      unphased: tickets.filter((t) => typeof t.meta?.milestoneOrder !== "number").length,
    };
  });
  return lines.sort(
    (a, b) =>
      Number(b.phase !== null) - Number(a.phase !== null) ||
      b.left + b.unphased - (a.left + a.unphased),
  );
}

/** Actionable only because a nudge is due: nothing else in it is yours to do. */
export function nudgeOnly(unit: Unit, ctx: BoardContext): boolean {
  if (unit.lane !== "actionable") return false;
  return unit.members
    .filter((m) => itemLane(m, ctx) === "actionable")
    .every((m) => m.section === "my_pr" && m.meta?.actionable !== true);
}

/** The earliest any member started waiting, as a time (Infinity when unknown). */
function waitedFrom(unit: Unit): number {
  const times = unit.members.map((m) => Date.parse(waitingSince(m) ?? "")).filter(Number.isFinite);
  return times.length ? Math.min(...times) : Infinity;
}

/**
 * Everything waiting on someone else, shown under the picks: units in the Waiting lane, plus
 * ones whose nudge is due that didn't make the picks. Nudges due first, then the longest wait.
 * A stack is one line, led by its bottom PR.
 */
export function waitingUnits(items: Item[], ctx: BoardContext, picked: Unit[]): Unit[] {
  const seen = new Set(picked.flatMap((u) => u.members.map((m) => m.id)));
  const units: Unit[] = [];
  for (const item of items) {
    if (item.status !== "open" || seen.has(item.id)) continue;
    const unit = unitOf(item, ctx);
    for (const member of unit.members) seen.add(member.id);
    if (unit.lane === "waiting" || nudgeOnly(unit, ctx)) {
      units.push({ ...unit, lead: unit.members[0]! });
    }
  }
  return units.sort(
    (a, b) =>
      Number(nudgeOnly(b, ctx)) - Number(nudgeOnly(a, ctx)) || waitedFrom(a) - waitedFrom(b),
  );
}

/** The greeting for the hour. */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Used when the morning sweep hasn't left a note (yet). */
export function fallbackNote(summaries: SectionSummary[]): string {
  const red = summaries.reduce((n, s) => n + s.counts.red, 0);
  const soon = summaries.reduce((n, s) => n + s.counts.amber, 0);
  const ready = summaries.find((s) => s.info.section === "my_pr")?.counts.green ?? 0;
  const parts: string[] = [];
  if (red > 0) parts.push(`${red} ${red === 1 ? "thing needs" : "things need"} you first`);
  if (soon > 0) parts.push(`${soon} coming up soon`);
  if (ready > 0) parts.push(`${ready} PR${ready === 1 ? " is" : "s are"} ready to merge`);
  if (parts.length === 0) return "A calm one today. Nothing urgent is waiting on you. ✨";
  return `Here's the shape of your day: ${parts.join(", ")}. One thing at a time.`;
}
