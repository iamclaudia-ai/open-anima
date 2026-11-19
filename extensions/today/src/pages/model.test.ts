import { describe, expect, test } from "bun:test";
import { stackOf } from "../stacks";
import {
  type BoardContext,
  fallbackNote,
  flagFor,
  type Item,
  inFlight,
  itemLane,
  liveReason,
  needsAttention,
  nudgeReason,
  phaseLines,
  rank,
  shortTitle,
  stackFlags,
  summarize,
  topPicks,
  waitingUnits,
} from "./model";

const NOW = new Date(2026, 10, 12, 8, 0, 0); // Nov 12, 8 AM local

function item(overrides: Partial<Item>): Item {
  return {
    id: 1,
    key: "k",
    project: "shop",
    section: "ticket",
    title: "ENG-1 Do the thing",
    url: null,
    waitingOn: null,
    stateLabel: "Todo",
    since: "2026-11-10T12:00:00.000Z",
    dueDate: null,
    meta: { priority: 0, stateType: "unstarted" },
    note: null,
    status: "open",
    doneBy: null,
    completedAt: null,
    pinned: false,
    topDate: null,
    topRank: null,
    topReason: null,
    topAt: null,
    sessionId: null,
    sessionWorkspaceId: null,
    sessionStack: false,
    question: null,
    askedAt: null,
    nudgedAt: null,
    stateSince: null,
    ...overrides,
  };
}

describe("flagFor", () => {
  test("due dates: overdue and today are red, this week amber", () => {
    expect(flagFor(item({ dueDate: "2026-11-10" }), NOW)).toMatchObject({
      tone: "red",
      text: "overdue 2d",
    });
    expect(flagFor(item({ dueDate: "2026-11-12" }), NOW)).toMatchObject({
      tone: "red",
      text: "due today",
    });
    expect(flagFor(item({ dueDate: "2026-11-13" }), NOW)).toMatchObject({
      tone: "amber",
      text: "due tomorrow",
    });
    expect(flagFor(item({ dueDate: "2026-11-30" }), NOW)).toBeNull();
  });

  test("PR states: only actionable PRs get a flag, toned by state", () => {
    const pr = (state: string, stateLabel: string, actionable = true) =>
      item({ section: "my_pr", stateLabel, meta: { state, actionable } });
    expect(flagFor(pr("changes_requested", "changes requested"), NOW)?.tone).toBe("red");
    expect(flagFor(pr("checks_failing", "2 checks failing"), NOW)).toMatchObject({
      tone: "red",
      text: "2 checks failing",
    });
    expect(flagFor(pr("ready", "ready to merge"), NOW)).toMatchObject({
      tone: "green",
      text: "ready to merge",
    });
    expect(flagFor(pr("open_comments", "approved · 4 open comments"), NOW)?.tone).toBe("amber");
    expect(flagFor(pr("your_turn", "your turn: sam"), NOW)?.tone).toBe("blue");
    expect(flagFor(pr("waiting_on_parent", "approved · waiting on #1", false), NOW)).toBeNull();
    expect(flagFor(pr("awaiting_review", "awaiting review", false), NOW)).toBeNull();
  });

  test("promises and reviews get amber once someone has waited a while", () => {
    const old = "2026-10-28T12:00:00.000Z"; // 14 days before NOW
    expect(flagFor(item({ section: "promise", since: old }), NOW)).toMatchObject({
      tone: "amber",
      text: "waiting 2w",
    });
    expect(
      flagFor(item({ section: "review", stateLabel: "review requested", since: old }), NOW)?.tone,
    ).toBe("amber");
    expect(flagFor(item({ section: "review", stateLabel: "review requested" }), NOW)).toBeNull();
  });
});

describe("needsAttention and rank", () => {
  test("PRs headline only when a session can act; tickets when startable and due or high", () => {
    expect(needsAttention(item({ section: "my_pr", meta: { actionable: false } }), NOW)).toBe(
      false,
    );
    expect(needsAttention(item({ section: "my_pr", meta: { actionable: true } }), NOW)).toBe(true);
    expect(needsAttention(item({}), NOW)).toBe(false);
    expect(
      needsAttention(item({ meta: { stateType: "started" }, stateLabel: "In Progress" }), NOW),
    ).toBe(false);
    expect(
      needsAttention(item({ meta: { stateType: "started" }, stateLabel: "In Review" }), NOW),
    ).toBe(false);
    expect(needsAttention(item({ dueDate: "2026-11-15" }), NOW)).toBe(true);
    expect(needsAttention(item({ meta: { priority: 1, stateType: "backlog" } }), NOW)).toBe(true);
  });

  test("started tickets and promises are in flight: their PRs carry them, never headlined", () => {
    const urgentStarted = item({
      dueDate: "2026-11-12",
      meta: { priority: 1, stateType: "started" },
      stateLabel: "In Review",
    });
    expect(inFlight(urgentStarted)).toBe(true);
    expect(needsAttention(urgentStarted, NOW)).toBe(false);
    const promise = (stateType?: string) =>
      item({ section: "promise", meta: stateType ? { stateType } : {} });
    expect(needsAttention(promise("unstarted"), NOW)).toBe(true);
    expect(needsAttention(promise("backlog"), NOW)).toBe(true);
    expect(needsAttention(promise(), NOW)).toBe(true); // a ledger promise with no ticket yet
    expect(needsAttention(promise("started"), NOW)).toBe(false);
    expect(inFlight(item({ section: "my_pr", meta: { stateType: "started" } }))).toBe(false);
    // Flags: only overdue / due today survive once a PR carries it.
    const old = "2026-07-01T12:00:00.000Z";
    expect(
      flagFor(item({ section: "promise", since: old, meta: { stateType: "started" } }), NOW),
    ).toBeNull();
    expect(flagFor(item({ meta: { priority: 1, stateType: "started" } }), NOW)).toBeNull();
    expect(flagFor(urgentStarted, NOW)).toMatchObject({ tone: "red", text: "due today" });
  });

  test("most urgent first", () => {
    const ranked = rank(
      [
        item({ id: 1, meta: { priority: 2 } }),
        item({ id: 2, dueDate: "2026-11-11" }),
        item({ id: 3, dueDate: "2026-11-13" }),
      ],
      NOW,
    );
    expect(ranked.map((i) => i.id)).toEqual([2, 3, 1]);
  });
});

describe("shortTitle", () => {
  test("drops conventional-commit prefixes and bracketed refs", () => {
    expect(
      shortTitle(
        item({
          title: "#121 feat(export): add CSV export to the reports page [ENG-101] (1/5)",
        }),
      ),
    ).toEqual({
      id: "#121",
      text: "Add CSV export to the reports page (1/5)",
    });
    expect(shortTitle(item({ title: "#122 feat: [ENG-102] add content" }))).toEqual({
      id: "#122",
      text: "Add content",
    });
    expect(shortTitle(item({ title: "ENG-103 [Checkout] Fix the login redirect" }))).toEqual({
      id: "ENG-103",
      text: "Fix the login redirect",
    });
    expect(shortTitle(item({ title: "Renew the domain" }))).toEqual({
      id: null,
      text: "Renew the domain",
    });
  });
});

function board(items: Item[], more: Partial<BoardContext> = {}): BoardContext {
  return {
    date: "2026-11-12",
    now: NOW,
    live: new Set<string>(),
    stackOf: (item) => stackOf(items, item),
    ...more,
  };
}

describe("summarize and the fallback note", () => {
  test("counts urgency per category", () => {
    const items = [
      item({ id: 1, dueDate: "2026-11-11" }),
      item({
        id: 2,
        section: "my_pr",
        stateLabel: "ready to merge",
        meta: { state: "ready", actionable: true },
      }),
      item({
        id: 3,
        section: "my_pr",
        stateLabel: "awaiting review",
        meta: { state: "awaiting_review", actionable: false },
      }),
    ];
    const summaries = summarize(items, NOW);
    const tickets = summaries.find((s) => s.info.section === "ticket")!;
    expect(tickets.counts.red).toBe(1);
    const prs = summaries.find((s) => s.info.section === "my_pr")!;
    expect(prs.headline.map((i) => i.id)).toEqual([2]);
    expect(prs.total).toBe(2);
    expect(fallbackNote(summaries)).toContain("1 thing needs you first");
    expect(fallbackNote(summaries)).toContain("1 PR is ready to merge");
  });
});

describe("lanes", () => {
  test("a question, then a live session, then your move, then waiting", () => {
    const pr = (state: string, actionable: boolean, more: Partial<Item> = {}) =>
      item({
        section: "my_pr",
        url: "https://github.com/o/r/pull/1",
        meta: { state, actionable },
        ...more,
      });
    const ctx = board([], { live: new Set(["live"]) });
    expect(itemLane(pr("ready", true, { question: "merge?" }), ctx)).toBe("asking");
    expect(itemLane(pr("re_review", false, { sessionId: "live" }), ctx)).toBe("working");
    expect(itemLane(pr("re_review", false, { sessionId: "resolved" }), ctx)).toBe("waiting");
    expect(itemLane(pr("checks_failing", true), ctx)).toBe("actionable");
    expect(itemLane(pr("ci_running", false), ctx)).toBe("waiting");
    expect(itemLane(pr("draft", false), ctx)).toBe("idle");
    expect(itemLane(item({ section: "review" }), ctx)).toBe("actionable");
    expect(itemLane(item({}), ctx)).toBe("actionable");
    expect(itemLane(item({ meta: { stateType: "started" } }), ctx)).toBe("idle");
    expect(itemLane(item({ status: "done" }), ctx)).toBe("idle");
  });

  test("waiting on review 3+ calendar days, since it began or since the last nudge: a nudge is due", () => {
    const waiting = (more: Partial<Item>) =>
      item({
        section: "my_pr",
        url: "https://github.com/o/r/pull/1",
        stateLabel: "awaiting review",
        meta: { state: "awaiting_review", actionable: false },
        ...more,
      });
    const nov = (day: number) =>
      board([], { date: `2026-11-${day}`, now: new Date(2026, 10, day, 9) });
    const since = waiting({ stateSince: "2026-11-10T15:00:00.000Z" });
    expect(itemLane(since, nov(12))).toBe("waiting");
    expect(itemLane(since, nov(13))).toBe("actionable");
    expect(flagFor(since, new Date(2026, 10, 13, 9))).toMatchObject({
      tone: "amber",
      text: "nudge due · 2d",
    });
    // Nudged on the 12th: quiet again until the 15th.
    const nudged = waiting({
      stateSince: "2026-11-05T15:00:00.000Z",
      nudgedAt: "2026-11-12T15:00:00.000Z",
    });
    expect(itemLane(nudged, nov(14))).toBe("waiting");
    expect(itemLane(nudged, nov(15))).toBe("actionable");
    // Re-reviews can be bumped too; CI and the PR underneath can't.
    expect(
      itemLane(
        waiting({
          stateSince: "2026-11-01T15:00:00.000Z",
          meta: { state: "re_review", actionable: false },
        }),
        nov(13),
      ),
    ).toBe("actionable");
    expect(
      itemLane(
        waiting({
          stateSince: "2026-11-01T15:00:00.000Z",
          meta: { state: "waiting_on_parent", actionable: false },
        }),
        nov(13),
      ),
    ).toBe("waiting");
  });
});

/** A sample board late in the day: queued picks, a stack, and PRs waiting on reviewers. */
describe("the live picks", () => {
  const DATE = "2026-11-13";
  const LATER = new Date(2026, 10, 13, 17, 30);
  const pr = (number: number, state: string, actionable: boolean, more: Partial<Item> = {}) =>
    item({
      id: number,
      key: `pr:o/r#${number}`,
      section: "my_pr",
      title: `#${number} PR ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      meta: { repo: "o/r", number, state, actionable, parent: null },
      ...more,
    });
  const queued = (rank: number, reason: string) => ({
    topDate: DATE,
    topRank: rank,
    topReason: reason,
  });
  const stackSession = { sessionId: "stack", sessionWorkspaceId: "ws", sessionStack: true };

  function sample(more: { live?: string[]; nudgedDaysAgo?: number } = {}) {
    const nudgedAt = new Date(
      LATER.getTime() - (more.nudgedDaysAgo ?? 0) * 86_400_000,
    ).toISOString();
    return [
      pr(101, "re_review", false, {
        stateLabel: "re-review: sam",
        stateSince: "2026-11-13T14:00:00.000Z",
        ...queued(1, "Answer Jordan's thread"),
      }),
      // A stack of three: its session finished. The bottom PR waits on pat's reply; the
      // real work is a CodeRabbit thread on the middle one and a failing check on the top.
      pr(102, "awaiting_reply", false, {
        stateLabel: "waiting on pat's reply",
        stateSince: "2026-11-13T21:17:00.000Z",
        ...stackSession,
        ...queued(2, "1 open comment"),
      }),
      pr(103, "open_comments", true, {
        stateLabel: "1 CodeRabbit comment",
        meta: {
          repo: "o/r",
          number: 103,
          state: "open_comments",
          actionable: true,
          parent: 102,
        },
        ...stackSession,
      }),
      pr(104, "checks_failing", true, {
        stateLabel: "1 check failing",
        meta: {
          repo: "o/r",
          number: 104,
          state: "checks_failing",
          actionable: true,
          parent: 103,
        },
        ...stackSession,
      }),
      pr(105, "awaiting_review", false, {
        stateLabel: "awaiting review",
        waitingOn: "jordan, casey",
        stateSince: "2026-11-06T15:00:00.000Z",
        nudgedAt,
        ...queued(3, "Worth a nudge before the weekend"),
      }),
      item({
        id: 4,
        section: "review",
        title: "#40 Their PR",
        stateLabel: "review requested",
        ...queued(4, "Review Casey's PR"),
      }),
      item({
        id: 5,
        title: "ENG-5 Priority work",
        meta: { priority: 2, stateType: "unstarted" },
        ...queued(5, "High priority"),
      }),
      // Not in the queue: the board's own ranking reaches these when the queue runs short.
      item({ id: 6, title: "ENG-6 Urgent", meta: { priority: 1, stateType: "unstarted" } }),
      pr(106, "ready", true, { stateLabel: "ready to merge" }),
      item({ id: 7, title: "ENG-7 Someday", meta: { priority: 4, stateType: "unstarted" } }),
    ];
  }
  const ctxFor = (items: Item[], live: string[] = [], date = DATE, now = LATER) =>
    board(items, { date, now, live: new Set(live), stackOf: (i) => stackOf(items, i) });
  const ids = (units: { lead: Item }[]) => units.map((u) => u.lead.id);

  test("waiting picks leave, the stack is judged whole, and the ranking fills the gap", () => {
    const items = sample();
    const ctx = ctxFor(items);
    const picks = topPicks(items, ctx);
    // #101 (re-review) and #105 (nudged today) are gone, and the queued review never takes a
    // place (the review page has them all); the urgent ticket and the ready PR move up from the
    // board's ranking. The someday ticket never makes it.
    expect(ids(picks)).toEqual([102, 5, 6, 106]);
    expect(picks[0]!.members.map((m) => m.id)).toEqual([102, 103, 104]);
    expect(stackFlags(picks[0]!, ctx).map((f) => [f.tone, f.text])).toEqual([
      ["amber", "#103 1 CodeRabbit comment"],
      ["red", "#104 1 check failing"],
    ]);
    // Waiting: the longest wait first (#101 since 14:00, #105 nudged at 17:30).
    expect(ids(waitingUnits(items, ctx, picks))).toEqual([101, 105]);
  });

  test("a live session keeps its item in the picks until it's done", () => {
    const items = sample();
    items[0]!.sessionId = "sam";
    items[0]!.sessionWorkspaceId = "ws";
    const picks = topPicks(items, ctxFor(items, ["sam"]));
    expect(ids(picks)).toEqual([101, 102, 5, 6, 106]);
    expect(picks[0]!.lane).toBe("working");
  });

  test("three days after the nudge, it's a pick again; a due nudge that doesn't fit waits first", () => {
    const items = sample({ nudgedDaysAgo: 3 });
    const ctx = ctxFor(items);
    const picks = topPicks(items, ctx);
    expect(ids(picks)).toEqual([102, 105, 5, 6, 106]);
    expect(flagFor(items[4]!, LATER)?.text).toBe("nudge due · 3d");
    // A pick of five more crowds it out: it leads the Waiting list instead.
    const crowded = topPicks(items, ctx, 1);
    expect(ids(crowded)).toEqual([102]);
    expect(ids(waitingUnits(items, ctx, crowded))[0]).toBe(105);
  });

  test("the last place goes to a current-phase ticket when none made it in", () => {
    const phase = (id: number, order: number, current: boolean) =>
      item({
        id,
        title: `ENG-${id} Phase work`,
        meta: {
          stateType: "unstarted",
          priority: 3,
          project: "Checkout redesign",
          activeProject: true,
          milestone: `${order}: Phase`,
          milestoneOrder: order,
          currentPhase: current,
        },
      });
    const items = [...sample({ nudgedDaysAgo: 3 }), phase(90, 4, true), phase(91, 7, false)];
    const picks = topPicks(items, ctxFor(items));
    // Without it the ready PR would be fifth; the later-phase ticket never counts.
    expect(ids(picks)).toEqual([102, 105, 5, 6, 90]);
    expect(
      flagFor(
        items.find((i) => i.id === 90)!,
        LATER,
      )?.text,
    ).toBe("phase 4");
    expect(
      needsAttention(
        items.find((i) => i.id === 91)!,
        LATER,
      ),
    ).toBe(false);
    // Already in by itself: nothing is displaced.
    const few = [phase(90, 4, true), ...sample().filter((i) => i.id === 6)];
    expect(ids(topPicks(few, ctxFor(few)))).toEqual([6, 90]);
  });

  test("phase lines: the current phase, what's left, later phases and unplanned tickets", () => {
    const t = (id: number, milestone: string | null, order: number | null, current = false) =>
      item({
        id,
        meta: {
          stateType: "unstarted",
          project: "Checkout redesign",
          activeProject: true,
          milestone,
          milestoneOrder: order,
          currentPhase: current,
        },
      });
    const lines = phaseLines([
      t(1, "1: Design", 1, true),
      t(2, "1: Design", 1, true),
      t(3, "3: Beta", 3),
      t(4, "2: Build", 2),
      t(5, null, null),
      item({ id: 6, meta: { project: "Other", activeProject: false } }),
    ]);
    expect(lines).toEqual([
      {
        project: "Checkout redesign",
        phase: "1: Design",
        left: 2,
        later: ["2", "3"],
        unphased: 1,
      },
    ]);
  });

  test("a stack with nothing to do waits, as one line led by its bottom PR", () => {
    const items = sample().map((i) =>
      i.id === 103 || i.id === 104
        ? {
            ...i,
            meta: { ...i.meta, state: "ci_running", actionable: false },
            stateLabel: "CI running",
          }
        : i,
    );
    const ctx = ctxFor(items);
    expect(ids(topPicks(items, ctx))).not.toContain(102);
    const waiting = waitingUnits(items, ctx, topPicks(items, ctx));
    const stack = waiting.find((u) => u.lead.id === 102)!;
    expect(stack.members).toHaveLength(3);
    expect(stackFlags(stack, ctx).map((f) => f.text)).toEqual([
      "#102 waiting on pat's reply · today",
      "#103 CI running",
      "#104 CI running",
    ]);
  });

  test("questions have their own list; finished items are gone", () => {
    const items = sample();
    items[5]!.question = "Approve as is?";
    items[6]!.status = "done";
    expect(ids(topPicks(items, ctxFor(items)))).toEqual([102, 6, 106]);
  });
});

describe("nudgeReason", () => {
  const pr = (more: Partial<Item>) =>
    item({
      section: "my_pr",
      stateLabel: "awaiting review",
      meta: { state: "awaiting_review" },
      ...more,
    });
  test("names who to nudge and since when", () => {
    expect(
      nudgeReason(pr({ waitingOn: "jordan, casey", stateSince: "2026-11-10T15:00:00.000Z" })),
    ).toBe("Nudge jordan, casey: no review since Nov 10");
    expect(
      nudgeReason(
        pr({
          stateLabel: "re-review: sam",
          stateSince: "2026-11-01T15:00:00.000Z",
          nudgedAt: "2026-11-09T15:00:00.000Z",
        }),
      ),
    ).toBe("Nudge sam again: nothing since your nudge on Nov 9");
  });
});

describe("liveReason", () => {
  const queuedAt = "2026-11-13T09:30:00.000Z";
  const pick = (more: Partial<Item>) =>
    item({ topDate: "2026-11-13", topReason: "Answer Jordan's thread", topAt: queuedAt, ...more });
  const unit = (lead: Item, others: Item[] = []) => ({
    lead,
    members: [lead, ...others],
    lane: "actionable" as const,
  });

  test("holds while nothing changed since it was queued, and goes once the state moves", () => {
    expect(liveReason(unit(pick({ stateSince: "2026-11-13T08:00:00.000Z" })), "2026-11-13")).toBe(
      "Answer Jordan's thread",
    );
    expect(
      liveReason(unit(pick({ stateSince: "2026-11-13T19:00:00.000Z" })), "2026-11-13"),
    ).toBeNull();
    // A stack: any PR in it moving makes the morning's story stale.
    const moved = item({ id: 2, stateSince: "2026-11-13T22:25:00.000Z" });
    expect(liveReason(unit(pick({}), [moved]), "2026-11-13")).toBeNull();
    // Yesterday's pick, or one queued before topAt was recorded.
    expect(liveReason(unit(pick({ topDate: "2026-11-12" })), "2026-11-13")).toBeNull();
    expect(
      liveReason(unit(pick({ topAt: null, stateSince: "2026-11-13T19:00:00.000Z" })), "2026-11-13"),
    ).toBe("Answer Jordan's thread");
  });
});
