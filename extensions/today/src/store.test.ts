import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  addItem,
  applyCollection,
  type CollectedItem,
  finishedSessions,
  getItem,
  getNote,
  listItems,
  setPinned,
  setNote,
  setSession,
  setStatus,
  setTop,
} from "./store";
import { todayTestDb } from "./test-db";

const T0 = "2026-11-12T09:00:00.000Z";
const T1 = "2026-11-12T10:00:00.000Z";
const T2 = "2026-11-12T11:00:00.000Z";
const T3 = "2026-11-12T12:00:00.000Z";

function ticket(id: string, updatedAt = T0): CollectedItem {
  return {
    key: `linear:${id}`,
    section: "ticket",
    title: `${id} something`,
    sourceUpdatedAt: updatedAt,
  };
}

describe("applyCollection", () => {
  let db: Database;
  beforeEach(() => {
    db = todayTestDb();
  });

  test("state_since moves only when the state does: a PR's kind, anything else's label", () => {
    const pr = (state: string, label: string): CollectedItem => ({
      key: "pr:o/r#1",
      section: "my_pr",
      title: "#1 a PR",
      stateLabel: label,
      since: T0,
      meta: { state },
    });
    applyCollection(db, "github:mine", "shop", [pr("open_comments", "2 open comments")], T1);
    expect(getItem(db, "pr:o/r#1")?.stateSince).toBe(T0); // a new item starts at its creation
    applyCollection(db, "github:mine", "shop", [pr("open_comments", "1 open comment")], T2);
    expect(getItem(db, "pr:o/r#1")?.stateSince).toBe(T0); // a count moved, not the state
    applyCollection(db, "github:mine", "shop", [pr("awaiting_review", "awaiting review")], T3);
    expect(getItem(db, "pr:o/r#1")?.stateSince).toBe(T3);

    applyCollection(db, "linear", "shop", [{ ...ticket("ENG-1"), stateLabel: "Todo" }], T1);
    applyCollection(db, "linear", "shop", [{ ...ticket("ENG-1"), stateLabel: "Blocked" }], T2);
    expect(getItem(db, "linear:ENG-1")?.stateSince).toBe(T2);
  });

  test("adds new items and completes ones missing from the next collection", () => {
    expect(
      applyCollection(db, "shop:linear", "shop", [ticket("ENG-1"), ticket("ENG-2")], T0),
    ).toEqual({
      added: 2,
      updated: 0,
      reopened: 0,
      completed: 0,
      closedIds: [],
    });
    const second = applyCollection(db, "shop:linear", "shop", [ticket("ENG-1")], T1);
    expect(second.completed).toBe(1);
    const gone = getItem(db, "linear:ENG-2");
    expect(second.closedIds).toEqual([gone!.id]);
    expect(gone?.status).toBe("done");
    expect(gone?.doneBy).toBe("collector");
    expect(gone?.completedAt).toBe(T1);
  });

  test("reopens an item the collector closed when it comes back", () => {
    applyCollection(db, "shop:linear", "shop", [ticket("ENG-1")], T0);
    applyCollection(db, "shop:linear", "shop", [], T1);
    const back = applyCollection(db, "shop:linear", "shop", [ticket("ENG-1")], T2);
    expect(back.reopened).toBe(1);
    expect(getItem(db, "linear:ENG-1")?.status).toBe("open");
  });

  test("your tick holds until the source changes after it", () => {
    applyCollection(db, "shop:linear", "shop", [ticket("ENG-1", T0)], T0);
    setStatus(db, "linear:ENG-1", "done", "user", T1);

    // Same source state: stays done.
    applyCollection(db, "shop:linear", "shop", [ticket("ENG-1", T0)], T2);
    expect(getItem(db, "linear:ENG-1")?.status).toBe("done");
    expect(getItem(db, "linear:ENG-1")?.doneBy).toBe("user");

    // Source moved after the tick (a new reply, a re-request): back on the list.
    const result = applyCollection(db, "shop:linear", "shop", [ticket("ENG-1", T2)], T3);
    expect(result.reopened).toBe(1);
    expect(getItem(db, "linear:ENG-1")?.status).toBe("open");
  });

  test("a dismissed item without a newer source stays dismissed, and isn't completed when missing", () => {
    applyCollection(db, "s:reviews", "shop", [ticket("ENG-1", T0)], T0);
    setStatus(db, "linear:ENG-1", "dismissed", "user", T1);
    applyCollection(db, "s:reviews", "shop", [], T2);
    expect(getItem(db, "linear:ENG-1")?.status).toBe("dismissed");
  });

  test("only reconciles rows owned by the same source", () => {
    applyCollection(db, "shop:linear", "shop", [ticket("ENG-1")], T0);
    addItem(db, { project: "shop", title: "Renew the domain" }, T0);
    applyCollection(db, "shop:ledger", "shop", [], T1);
    expect(
      listItems(db)
        .map((i) => i.section)
        .sort(),
    ).toEqual(["promise", "ticket"]);
  });

  test("normalizes timestamps so mixed formats compare correctly", () => {
    applyCollection(
      db,
      "s",
      "shop",
      [
        {
          ...ticket("ENG-1"),
          sourceUpdatedAt: "2026-11-12T10:00:00Z",
          since: "2026-11-01T00:00:00Z",
        },
      ],
      T0,
    );
    const item = getItem(db, "linear:ENG-1");
    expect(item?.sourceUpdatedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(item?.since).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("finishedSessions", () => {
  test("a session is finished once every item it works is closed", () => {
    const db = todayTestDb();
    applyCollection(
      db,
      "shop:linear",
      "shop",
      ["ENG-1", "ENG-2", "ENG-3"].map((id) => ticket(id)),
      T0,
    );
    setSession(db, "linear:ENG-1", { sessionId: "stack", workspaceId: "ws" }, T0, true);
    setSession(db, "linear:ENG-2", { sessionId: "stack", workspaceId: "ws" }, T0, true);
    setSession(db, "linear:ENG-3", { sessionId: "solo", workspaceId: "ws" }, T0);

    const first = applyCollection(db, "shop:linear", "shop", [ticket("ENG-2")], T1);
    // ENG-1's stack still has ENG-2 open; ENG-3 was all "solo" worked.
    expect(finishedSessions(db, first.closedIds)).toEqual(["solo"]);

    const done = setStatus(db, "linear:ENG-2", "done", "user", T2);
    expect(finishedSessions(db, [done.id])).toEqual(["stack"]);
    expect(finishedSessions(db, [getItem(db, "linear:ENG-2")!.id, done.id])).toEqual(["stack"]);
  });
});

describe("listItems", () => {
  test("open by default, plus items finished since doneSince", () => {
    const db = todayTestDb();
    applyCollection(db, "s", "shop", [ticket("ENG-1"), ticket("ENG-2"), ticket("ENG-3")], T0);
    setStatus(db, "linear:ENG-2", "done", "user", T1);
    setStatus(db, "linear:ENG-3", "done", "user", T3);
    expect(listItems(db).map((i) => i.key)).toEqual(["linear:ENG-1"]);
    expect(
      listItems(db, { doneSince: T2 })
        .map((i) => i.key)
        .sort(),
    ).toEqual(["linear:ENG-1", "linear:ENG-3"]);
    expect(
      listItems(db, { status: "done", doneBy: "user", doneSince: T2 }).map((i) => i.key),
    ).toEqual(["linear:ENG-3"]);
  });
});

describe("setTop and pins", () => {
  test("replaces the picks for a date and reports unknown keys", () => {
    const db = todayTestDb();
    applyCollection(db, "s", "shop", [ticket("ENG-1"), ticket("ENG-2")], T0);
    setTop(db, "2026-11-12", [{ key: "linear:ENG-1", reason: "due today" }], T0);
    const result = setTop(
      db,
      "2026-11-12",
      [{ key: "linear:ENG-2", reason: "Jordan is waiting" }, { key: "linear:NOPE" }],
      T1,
    );
    expect(result).toEqual({ set: 1, missing: ["linear:NOPE"], quiet: [] });
    expect(getItem(db, "linear:ENG-1")?.topDate).toBeNull();
    const top = getItem(db, "linear:ENG-2");
    expect(top?.topRank).toBe(1);
    expect(top?.topReason).toBe("Jordan is waiting");
    expect(top?.topAt).toBe(T1);
    expect(getItem(db, "linear:ENG-1")?.topAt).toBeNull();
  });

  test("pins and unpins", () => {
    const db = todayTestDb();
    applyCollection(db, "s", "shop", [ticket("ENG-1")], T0);
    expect(setPinned(db, "linear:ENG-1", true, T1).pinned).toBe(true);
    expect(setPinned(db, "linear:ENG-1", false, T2).pinned).toBe(false);
  });
});

describe("addItem", () => {
  test("upserts by key and refuses collector-owned keys", () => {
    const db = todayTestDb();
    const first = addItem(db, { key: "manual:x", project: "shop", title: "One" }, T0);
    const second = addItem(db, { key: "manual:x", project: "shop", title: "Two" }, T1);
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Two");
    applyCollection(db, "s", "shop", [ticket("ENG-1")], T0);
    expect(() => addItem(db, { key: "linear:ENG-1", project: "shop", title: "x" }, T1)).toThrow(
      /belongs to collector/,
    );
  });
});

describe("the note", () => {
  test("keeps the latest text for the day and when it was written", () => {
    const db = todayTestDb();
    expect(getNote(db, "2026-11-12")).toBeNull();
    setNote(db, "2026-11-12", "Good morning", T0);
    setNote(db, "2026-11-12", "Three down, two to go", T2);
    expect(getNote(db, "2026-11-12")).toEqual({
      text: "Three down, two to go",
      updatedAt: T2,
      picks: [],
    });
    setNote(db, "2026-11-12", "Two to go", T3, ["pr:o/r#1", "linear:ENG-1"]);
    expect(getNote(db, "2026-11-12")?.picks).toEqual(["pr:o/r#1", "linear:ENG-1"]);
    expect(getNote(db, "2026-11-13")).toBeNull();
  });
});
