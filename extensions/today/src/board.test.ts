import { describe, expect, test } from "bun:test";
import { liveBoard } from "./board";
import type { Item } from "./pages/model";

const DATE = "2026-11-13";
const NOW = new Date(2026, 10, 13, 14, 0);

function item(id: number, more: Partial<Item>): Item {
  return {
    id,
    key: `k${id}`,
    project: "shop",
    section: "my_pr",
    title: `#${id} PR ${id}`,
    url: `https://github.com/o/r/pull/${id}`,
    waitingOn: null,
    stateLabel: null,
    since: "2026-11-01T12:00:00.000Z",
    dueDate: null,
    meta: { repo: "o/r", number: id, state: "ready", actionable: true, parent: null },
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
    ...more,
  };
}

describe("liveBoard", () => {
  test("picks, waiting, questions and how much of the queue still moves", () => {
    const board = liveBoard(
      [
        item(1, { stateLabel: "ready to merge", topDate: DATE, topRank: 1, topReason: "Merge it" }),
        item(2, {
          stateLabel: "re-review: sam",
          meta: { repo: "o/r", number: 2, state: "re_review", actionable: false, parent: null },
          stateSince: "2026-11-13T15:00:00.000Z",
          topDate: DATE,
          topRank: 2,
        }),
        item(3, {
          stateLabel: "awaiting review",
          meta: {
            repo: "o/r",
            number: 3,
            state: "awaiting_review",
            actionable: false,
            parent: null,
          },
          sessionId: "live",
          sessionWorkspaceId: "ws",
        }),
        item(4, { section: "review", title: "#4 Theirs", question: "Approve?" }),
        item(5, { status: "done", topDate: DATE, topRank: 3 }),
      ],
      { date: DATE, now: NOW, live: new Set(["live"]) },
    );
    expect(board.picks.map((p) => [p.key, p.lane, p.fromQueue, p.reason])).toEqual([
      ["k1", "actionable", true, "Merge it"],
      ["k3", "working", false, null],
    ]);
    expect(board.picks[0]!.says).toEqual(["ready to merge"]);
    expect(board.waiting).toEqual([
      {
        key: "k2",
        title: "#2 PR 2",
        lane: "waiting",
        says: ["re-review: sam · today"],
        nudgeDue: false,
      },
    ]);
    expect(board.asking).toEqual([{ key: "k4", title: "#4 Theirs", question: "Approve?" }]);
    expect(board.queue).toEqual({ open: 2, moving: 1 });
  });
});
