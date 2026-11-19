import { describe, expect, test } from "bun:test";
import type { LinearGraphql } from "./collectors/linear";
import { createTodayExtension } from "./index";
import { flagFor, type Item, itemLane, needsAttention, topPicks } from "./pages/model";
import {
  SNOOZE_FOREVER,
  SNOOZE_MUTATION,
  snoozeDate,
  snoozedUntil,
  snoozeText,
  snoozeTicket,
  withSnoozes,
} from "./snooze";
import { applyCollection, type TodayItem } from "./store";
import { todayTestDb } from "./test-db";

const NOW = new Date("2026-11-17T23:00:00.000Z");
const LATER = "2026-11-24T11:00:00.000Z";

function item(overrides: Partial<Item>): Item {
  return {
    id: 1,
    key: "linear:ENG-1",
    project: "shop",
    section: "promise",
    title: "ENG-1 Share the agent setup",
    url: null,
    waitingOn: null,
    stateLabel: "Todo",
    since: "2026-11-10T12:00:00.000Z",
    dueDate: null,
    meta: { identifier: "ENG-1", stateType: "unstarted" },
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

describe("snooze helpers", () => {
  test("a ticket snoozes itself; a promise snoozes through its ticket; others can't", () => {
    expect(snoozeTicket(item({}))).toBe("ENG-1");
    expect(snoozeTicket(item({ key: "slack:C1:1.2", meta: { ticket: "ENG-107" } }))).toBe(
      "ENG-107",
    );
    expect(snoozeTicket(item({ key: "slack:C1:1.2", meta: {} }))).toBeNull();
    expect(
      snoozeTicket(item({ key: "pr:o/r#1", section: "my_pr", meta: { number: 1 } })),
    ).toBeNull();
  });

  test("a snooze only counts while it's ahead", () => {
    expect(snoozedUntil(item({ meta: { snoozedUntil: LATER } }), NOW)).toBe(LATER);
    expect(snoozedUntil(item({ meta: { snoozedUntil: "2026-11-01T00:00:00Z" } }), NOW)).toBeNull();
    expect(snoozedUntil(item({ meta: { snoozedUntil: null } }), NOW)).toBeNull();
  });

  test("a promise takes its ticket's snooze", () => {
    const [ticket, promise, other] = withSnoozes([
      item({ meta: { identifier: "ENG-1", snoozedUntil: LATER } }),
      item({ id: 2, key: "slack:C1:1.2", meta: { ticket: "ENG-1" } }),
      item({ id: 3, key: "slack:C1:3.4", meta: { ticket: "ENG-9" } }),
    ]);
    expect(ticket!.meta?.snoozedUntil).toBe(LATER);
    expect(promise!.meta).toEqual({ ticket: "ENG-1", snoozedUntil: LATER });
    expect(other!.meta?.snoozedUntil).toBeUndefined();
  });

  test("choices end at 6 AM local; forever is a far date and reads as plain 'snoozed'", () => {
    const now = new Date(2026, 10, 17, 18, 30);
    expect(new Date(snoozeDate("day", now))).toEqual(new Date(2026, 10, 18, 6, 0));
    expect(new Date(snoozeDate("week", now))).toEqual(new Date(2026, 10, 24, 6, 0));
    expect(new Date(snoozeDate("month", now))).toEqual(new Date(2026, 11, 17, 6, 0));
    expect(snoozeDate("forever", now)).toBe(SNOOZE_FOREVER);
    expect(snoozeText(SNOOZE_FOREVER)).toBe("snoozed");
    expect(snoozeText(LATER)).toBe("snoozed · Nov 24");
  });
});

describe("a snoozed item on the board", () => {
  const ctx = (_items: Item[]) => ({
    date: "2026-11-17",
    now: NOW,
    live: new Set<string>(),
    stackOf: () => null,
  });

  test("leaves the picks, the headlines and the waiting list, and says why", () => {
    const sleeping = item({
      meta: { identifier: "ENG-1", snoozedUntil: LATER },
      topDate: "2026-11-17",
      topRank: 1,
    });
    const awake = item({ id: 2, key: "linear:ENG-2", meta: { identifier: "ENG-2" } });
    const items = [sleeping, awake];
    expect(topPicks(items, ctx(items)).map((u) => u.lead.id)).toEqual([2]);
    expect(itemLane(sleeping, ctx(items))).toBe("idle");
    expect(needsAttention(sleeping, NOW)).toBe(false);
    expect(flagFor(sleeping, NOW)).toMatchObject({ tone: "gray", text: "snoozed · Nov 24" });
  });

  test("a question from its session still reaches you", () => {
    const asked = item({
      meta: { identifier: "ENG-1", snoozedUntil: LATER },
      question: "Which env?",
    });
    expect(itemLane(asked, ctx([asked]))).toBe("asking");
  });
});

describe("today.snooze", () => {
  test("sets the snooze in Linear and shows it at once on the ticket and its promise", async () => {
    const ran: Array<{ key: string; query: string; variables?: Record<string, unknown> }> = [];
    const db = todayTestDb();
    const extension = createTodayExtension(
      {
        linear: { apiKey: "lin_api_test" },
        projects: [{ name: "shop", cwd: "/repo/shop", linear: {} }],
      },
      {
        openDb: () => db,
        now: () => NOW,
        env: {},
        linear: (key) =>
          (async (query: string, variables?: Record<string, unknown>) => {
            ran.push({ key, query, variables });
            return { issueUpdate: { success: true, issue: { snoozedUntilAt: LATER } } };
          }) as LinearGraphql,
      },
    );
    const at = NOW.toISOString();
    applyCollection(
      db,
      "shop:linear",
      "shop",
      [
        {
          key: "linear:ENG-107",
          section: "ticket",
          title: "ENG-107 Tidy the settings page",
          meta: { identifier: "ENG-107" },
        },
      ],
      at,
    );
    applyCollection(
      db,
      "shop:ledger",
      "shop",
      [
        {
          key: "slack:C1:1.2",
          section: "promise",
          title: "Waiting on Jordan",
          meta: { ticket: "ENG-107" },
        },
      ],
      at,
    );

    await extension.handleMethod("today.snooze", { key: "slack:C1:1.2", until: LATER });
    expect(ran).toEqual([
      {
        key: "lin_api_test",
        query: SNOOZE_MUTATION,
        variables: { id: "ENG-107", at: LATER },
      },
    ]);
    const { items } = (await extension.handleMethod("today.list", {})) as { items: TodayItem[] };
    expect(items.map((i) => [i.key, i.meta?.snoozedUntil])).toEqual(
      expect.arrayContaining([
        ["linear:ENG-107", LATER],
        ["slack:C1:1.2", LATER],
      ]),
    );

    await extension.handleMethod("today.snooze", { key: "linear:ENG-107", until: null });
    expect(ran[1]!.variables).toEqual({ id: "ENG-107", at: null });
  });

  test("without a Linear key, snoozing says so and calls nothing", async () => {
    const db = todayTestDb();
    let called = false;
    const extension = createTodayExtension(
      { projects: [{ name: "shop", cwd: "/repo/shop", linear: {} }] },
      {
        openDb: () => db,
        now: () => NOW,
        env: {},
        linear: () =>
          (async () => {
            called = true;
            return {};
          }) as LinearGraphql,
      },
    );
    applyCollection(
      db,
      "shop:linear",
      "shop",
      [{ key: "linear:ENG-1", section: "ticket", title: "ENG-1", meta: { identifier: "ENG-1" } }],
      NOW.toISOString(),
    );
    await expect(
      extension.handleMethod("today.snooze", { key: "linear:ENG-1", until: LATER }),
    ).rejects.toThrow(/Linear isn't configured/);
    expect(called).toBe(false);
  });

  test("an item without a ticket can't be snoozed, and nothing runs", async () => {
    const ran: string[][] = [];
    const db = todayTestDb();
    const extension = createTodayExtension(
      { projects: [] },
      { openDb: () => db, now: () => NOW, run: async (argv) => (ran.push(argv), "{}") },
    );
    applyCollection(
      db,
      "shop:mine:o/r",
      "shop",
      [{ key: "pr:o/r#1", section: "my_pr", title: "#1" }],
      NOW.toISOString(),
    );
    await expect(
      extension.handleMethod("today.snooze", { key: "pr:o/r#1", until: LATER }),
    ).rejects.toThrow(/no Linear ticket/);
    expect(ran).toEqual([]);
  });

  test("a failed Linear update throws instead of pretending", async () => {
    const db = todayTestDb();
    const extension = createTodayExtension(
      { projects: [{ name: "shop", cwd: "/repo/shop", linear: {} }] },
      {
        openDb: () => db,
        now: () => NOW,
        env: { LINEAR_API_KEY: "lin_api_env" },
        linear: () => (async () => ({ issueUpdate: { success: false } })) as LinearGraphql,
      },
    );
    applyCollection(
      db,
      "shop:linear",
      "shop",
      [{ key: "linear:ENG-1", section: "ticket", title: "ENG-1", meta: { identifier: "ENG-1" } }],
      NOW.toISOString(),
    );
    await expect(
      extension.handleMethod("today.snooze", { key: "linear:ENG-1", until: LATER }),
    ).rejects.toThrow(/didn't snooze ENG-1/);
  });
});
