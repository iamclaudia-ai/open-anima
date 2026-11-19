/**
 * Today — the live board as the page shows it, for the server: the top picks, what waits on
 * someone else, the questions for you, and how much of the morning's queue is still yours to
 * do. The day refresh reads it (`today.board`) to decide when the note has fallen behind the
 * board, and `today.set_note` records which picks a note was written over. Pure.
 */

import { nudgeDue } from "./nudge";
import {
  asking,
  type BoardContext,
  flagFor,
  type Item,
  liveReason,
  type Lane,
  stackFlags,
  topPicks,
  unitOf,
  type Unit,
  waitingFlag,
  waitingUnits,
} from "./pages/model";
import { stackOf } from "./stacks";

export interface BoardLine {
  key: string;
  title: string;
  lane: Lane;
  /** What the line says: its flag, a stack's PRs, or what it waits on. */
  says: string[];
  /** Every PR's key when it's a stack (bottom first). */
  stack?: string[];
}

export interface BoardSummary {
  date: string;
  picks: Array<BoardLine & { fromQueue: boolean; reason: string | null }>;
  waiting: Array<BoardLine & { nudgeDue: boolean }>;
  asking: Array<{ key: string; title: string; question: string }>;
  /** The morning's queue (today's picks): how many are open, and how many still yours to act on. */
  queue: { open: number; moving: number };
}

function line(unit: Unit, says: string[]): BoardLine {
  return {
    key: unit.lead.key,
    title: unit.lead.title,
    lane: unit.lane,
    says,
    ...(unit.members.length > 1 ? { stack: unit.members.map((m) => m.key) } : {}),
  };
}

/** The board for `items` (open ones; others are ignored) on `date`, with `live` sessions. */
export function liveBoard(
  items: Item[],
  options: { date: string; now: Date; live: ReadonlySet<string> },
): BoardSummary {
  const open = items.filter((i) => i.status === "open");
  const ctx: BoardContext = { ...options, stackOf: (item) => stackOf(open, item) };
  const picks = topPicks(open, ctx);
  const waiting = waitingUnits(open, ctx, picks);
  const queued = open.filter((i) => i.topDate === options.date);
  const ownFlag = (unit: Unit) => {
    const flags = stackFlags(unit, ctx);
    if (flags.length > 0) return flags.map((f) => f.text);
    const flag = flagFor(unit.lead, options.now);
    return flag ? [flag.text] : [];
  };
  return {
    date: options.date,
    picks: picks.map((unit) => ({
      ...line(unit, ownFlag(unit)),
      fromQueue: unit.lead.topDate === options.date,
      reason: liveReason(unit, options.date),
    })),
    waiting: waiting.map((unit) => {
      const flags = stackFlags(unit, ctx);
      return {
        ...line(
          unit,
          flags.length > 0 ? flags.map((f) => f.text) : [waitingFlag(unit.lead, options.now).text],
        ),
        nudgeDue: unit.members.some((m) => nudgeDue(m, options.date)),
      };
    }),
    asking: open
      .filter(asking)
      .map((i) => ({ key: i.key, title: i.title, question: i.question ?? "" })),
    queue: {
      open: queued.length,
      moving: queued.filter((i) => {
        const lane = unitOf(i, ctx).lane;
        return lane === "working" || lane === "actionable";
      }).length,
    },
  };
}
