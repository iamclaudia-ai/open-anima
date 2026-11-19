import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { CHECK_MY_PRS, type MyPrRow } from "./collectors/github";
import {
  autoFollowUps,
  type FollowUpItem,
  followUpPrompt,
  followUpsToReset,
  type LiveSession,
} from "./follow-up";
import { createTodayExtension } from "./index";
import { getItem, setSession } from "./store";
import { todayTestDb } from "./test-db";

const NOW = Date.parse("2026-11-16T22:00:00.000Z");
const MIN = 60_000;

function pr(id: number, more: Partial<FollowUpItem> = {}): FollowUpItem {
  return {
    id,
    key: `pr:o/r#${id}`,
    section: "my_pr",
    status: "open",
    title: `#${id} A PR`,
    url: `https://github.com/o/r/pull/${id}`,
    stateLabel: "conflicts",
    meta: { state: "conflicts", actionable: true },
    sessionId: "s1",
    sessionWorkspaceId: "ws",
    question: null,
    sourceUpdatedAt: "2026-11-16T21:00:00.000Z",
    followUpAt: null,
    followUpKey: null,
    followUpAuto: 0,
    ...more,
  };
}

const quiet: LiveSession = {
  runtimeStatus: "stalled",
  disposition: "open",
  lastActivity: new Date(NOW - 30 * MIN).toISOString(),
};

const ids = (items: FollowUpItem[], live = new Map<string, LiveSession>()) =>
  autoFollowUps(items, live, NOW).map((f) => [f.sessionId, f.items.map((i) => i.id)]);

describe("autoFollowUps", () => {
  test("a PR that needs work again, with a finished session, goes back to it", () => {
    // Marked done: not in the attention queue at all.
    expect(ids([pr(1)])).toEqual([["s1", [1]]]);
    expect(ids([pr(1)], new Map([["s1", quiet]]))).toEqual([["s1", [1]]]);
  });

  test("a stack's session gets all its PRs in one prompt", () => {
    const items = [
      pr(1),
      pr(2, {
        meta: { state: "open_comments", actionable: true },
        stateLabel: "2 CodeRabbit comments",
      }),
      pr(3, { meta: { state: "awaiting_review", actionable: false } }),
      pr(4, { sessionId: "s2" }),
    ];
    expect(ids(items)).toEqual([
      ["s1", [1, 2]],
      ["s2", [4]],
    ]);
  });

  test("only states a session can act on", () => {
    for (const state of ["ready", "re_request", "awaiting_review", "ci_running", "draft"]) {
      expect(ids([pr(1, { meta: { state, actionable: state !== "awaiting_review" } })])).toEqual(
        [],
      );
    }
    expect(ids([pr(1, { section: "review" })])).toEqual([]);
    expect(ids([pr(1, { status: "done" })])).toEqual([]);
    expect(ids([pr(1, { sessionId: null })])).toEqual([]);
  });

  test("never while the session is busy, recent, or waiting on you", () => {
    const at = (s: Partial<LiveSession>) => new Map([["s1", { ...quiet, ...s }]]);
    expect(ids([pr(1)], at({ runtimeStatus: "running" }))).toEqual([]);
    expect(ids([pr(1)], at({ runtimeStatus: "awaiting_approval" }))).toEqual([]);
    expect(ids([pr(1)], at({ worktreeSetup: { state: "running" } }))).toEqual([]);
    expect(ids([pr(1)], at({ lastActivity: new Date(NOW - 5 * MIN).toISOString() }))).toEqual([]);
    expect(ids([pr(1)], at({ disposition: "blocked" }))).toEqual([]);
    expect(ids([pr(1)], at({ disposition: "needs_review" }))).toEqual([]);
    expect(ids([pr(1, { question: "Merge it?" })])).toEqual([]);
  });

  test("once per PR state, within the cooldown and the cap", () => {
    const sent = { followUpKey: "conflicts@2026-11-16T21:00:00.000Z" };
    expect(ids([pr(1, sent)])).toEqual([]);
    // A new push or comment is a new state of the PR…
    const newer = { sourceUpdatedAt: "2026-11-16T21:40:00.000Z" };
    expect(
      ids([pr(1, { ...sent, ...newer, followUpAt: new Date(NOW - 60 * MIN).toISOString() })]),
    ).toEqual([["s1", [1]]]);
    // …but not within 30 minutes of the last follow-up, and not past three in a row.
    expect(
      ids([pr(1, { ...sent, ...newer, followUpAt: new Date(NOW - 10 * MIN).toISOString() })]),
    ).toEqual([]);
    expect(ids([pr(1, { ...newer, followUpAuto: 3 })])).toEqual([]);
  });
});

test("followUpsToReset: only items that stopped needing us", () => {
  const items = [
    pr(1, { followUpAuto: 2 }),
    pr(2, { followUpAuto: 3, meta: { state: "re_review", actionable: false } }),
    pr(3, { followUpAuto: 0, meta: { state: "re_review", actionable: false } }),
  ];
  expect(followUpsToReset(items)).toEqual([2]);
});

test("followUpPrompt says what changed and how to hand it back", () => {
  const text = followUpPrompt(
    [
      pr(1, {
        stateLabel: "your turn: riley",
        meta: { state: "your_turn", actionable: true },
      }),
    ],
    { auto: true },
  );
  expect(text).toContain("moved on since your last turn");
  expect(text).toContain("#1 A PR: **your turn: riley**");
  expect(text).toContain("re-requesting their review");
  // Sent back by the board on its own, it still prepares and asks before anything leaves.
  expect(text).toContain("Stop and ask me before you do any of these: push a branch");
  expect(text).toContain("say so in a line and stop");
  expect(text).toContain("anima today ask --key 'pr:o/r#1'");

  const manual = followUpPrompt([pr(1)], { auto: false, context: "Rebase only, no other changes" });
  expect(manual).toContain("My note before you start");
  expect(manual).toContain("Rebase only, no other changes");
  expect(manual).not.toContain("by itself");
});

// ── The extension: after a collection, and the Continue button ──

function myPrRow(number: number, more: Partial<MyPrRow> = {}): MyPrRow {
  return {
    number,
    title: "A PR",
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    updatedAt: "2026-11-16T21:00:00Z",
    headRefName: `b${number}`,
    baseRefName: "main",
    defaultBranch: "main",
    conflicts: true,
    reviewDecision: "REVIEW_REQUIRED",
    approved: false,
    designerOnly: false,
    openThreads: 0,
    requested: [],
    approvedBy: [],
    changesBy: [],
    reReview: [],
    yourTurn: [],
    notReRequested: [],
    parent: null,
    parentApproved: null,
    waitingOn: null,
    ...more,
  };
}

async function board(live: Array<LiveSession & { sessionId: string }>) {
  const db = todayTestDb();
  let rows: MyPrRow[] = [myPrRow(7)];
  let now = NOW;
  const prompts: Array<{ sessionId: string; content: string }> = [];
  const extension = createTodayExtension(
    {
      githubIntervalMinutes: 1,
      projects: [{ name: "shop", cwd: "/repo/shop", github: { repos: ["o/r"], reviews: false } }],
    },
    {
      openDb: () => db,
      now: () => new Date(now),
      run: async (args) =>
        args[0] === CHECK_MY_PRS
          ? JSON.stringify(rows)
          : JSON.stringify({ limit: 5000, remaining: 5000, reset: NOW / 1000 + 3600 }),
    },
  );
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
    on: () => () => {},
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === "session.list_attention") return { sessions: live };
      if (method === "session.send_prompt") {
        prompts.push({ sessionId: String(params.sessionId), content: String(params.content) });
      }
      return {};
    },
  } as unknown as ExtensionContext;
  await extension.start(ctx);
  await extension.handleMethod("today.refresh", {});
  const item = getItem(db, "pr:o/r#7")!;
  return {
    extension,
    db,
    item,
    prompts,
    link: (sessionId: string) => setSession(db, item.id, { sessionId, workspaceId: "ws" }, "x"),
    setRows: (next: MyPrRow[]) => (rows = next),
    advance: (ms: number) => (now += ms),
    refresh: () => extension.handleMethod("today.refresh", {}),
  };
}

describe("today extension follow-ups", () => {
  test("a collection sends a finished session back to its conflicting PR, once", async () => {
    const b = await board([]);
    b.link("s1");
    await b.refresh();
    expect(b.prompts.map((p) => p.sessionId)).toEqual(["s1"]);
    expect(b.prompts[0]!.content).toContain("#7 A PR: **conflicts**");
    expect(getItem(b.db, b.item.id)!.followUpAuto).toBe(1);

    // Same state of the PR: nothing new to say.
    b.advance(60 * MIN);
    await b.refresh();
    expect(b.prompts).toHaveLength(1);

    // Main moved again (a new update): back it goes.
    b.setRows([myPrRow(7, { updatedAt: "2026-11-16T22:30:00Z" })]);
    await b.refresh();
    expect(b.prompts).toHaveLength(2);

    // Off to the reviewers: the count starts over.
    b.setRows([myPrRow(7, { conflicts: false, requested: ["sam"] })]);
    await b.refresh();
    expect(getItem(b.db, b.item.id)!.followUpAuto).toBe(0);
    expect(b.prompts).toHaveLength(2);
    await b.extension.stop();
  });

  test("a session that's working is left alone", async () => {
    const b = await board([{ sessionId: "s1", runtimeStatus: "running" }]);
    b.link("s1");
    await b.refresh();
    expect(b.prompts).toEqual([]);
    await expect(b.extension.handleMethod("today.follow_up", { id: b.item.id })).rejects.toThrow(
      "working right now",
    );
    await b.extension.stop();
  });

  test("Continue sends the session back with your note, whatever the PR's state", async () => {
    const b = await board([]);
    b.setRows([myPrRow(7, { conflicts: false, requested: ["sam"] })]);
    await b.refresh();
    await expect(b.extension.handleMethod("today.follow_up", { id: b.item.id })).rejects.toThrow(
      "no session yet",
    );
    b.link("s1");
    await b.extension.handleMethod("today.follow_up", {
      id: b.item.id,
      context: "Check Jordan's Slack thread first",
    });
    expect(b.prompts.map((p) => p.sessionId)).toEqual(["s1"]);
    expect(b.prompts[0]!.content).toContain("Check Jordan's Slack thread first");
    expect(getItem(b.db, b.item.id)!.followUpAt).not.toBeNull();
    await b.extension.stop();
  });
});
