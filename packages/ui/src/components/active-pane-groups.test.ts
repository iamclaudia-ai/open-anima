import { describe, expect, test } from "bun:test";
import {
  groupNested,
  nestedLabel,
  nestSessions,
  splitBackground,
  type ActiveGroup,
} from "./active-pane-groups";
import type { ActiveSessionRow } from "./NavigationDrawer";

function row(
  sessionId: string,
  parentSessionId: string | null = null,
  extra: Partial<ActiveSessionRow> = {},
): ActiveSessionRow {
  return {
    sessionId,
    workspaceId: "ws",
    workspaceName: "ws",
    title: sessionId,
    firstPrompt: null,
    runtimeStatus: "running",
    disposition: "open",
    waitingSince: "2026-11-02T00:00:00.000Z",
    pinned: false,
    parentSessionId,
    ...extra,
  };
}

/** A session another session launched (not a subagent). */
const launched = (sessionId: string, launcher: string, extra: Partial<ActiveSessionRow> = {}) =>
  row(sessionId, null, { origin: "automated", launchedBySessionId: launcher, ...extra });

const ids = (rows: ActiveSessionRow[]) => rows.map((r) => r.sessionId);
const shape = (groups: ActiveGroup[]) => groups.map((g) => [g.row.sessionId, ids(g.nested)]);

describe("nestSessions", () => {
  test("puts each subagent directly under its parent, siblings in server order", () => {
    // Server order is newest first, so children usually arrive before their parent.
    const rows = [row("1b", "coord"), row("other"), row("1a", "coord"), row("coord")];
    expect(ids(nestSessions(rows))).toEqual(["other", "coord", "1b", "1a"]);
  });

  test("a subagent whose parent isn't listed keeps its own place", () => {
    const rows = [row("a"), row("orphan", "resolved-parent"), row("b")];
    expect(ids(nestSessions(rows))).toEqual(["a", "orphan", "b"]);
  });

  test("nests a subagent's own subagents under it", () => {
    const rows = [row("grandchild", "child"), row("child", "root"), row("root")];
    expect(ids(nestSessions(rows))).toEqual(["root", "child", "grandchild"]);
  });

  test("nests a launched session under the session that launched it", () => {
    const rows = [launched("reviewer", "work"), row("other"), row("work")];
    expect(ids(nestSessions(rows))).toEqual(["other", "work", "reviewer"]);
  });

  test("a subagent parent outranks a launcher", () => {
    const rows = [
      row("child", "parent", { launchedBySessionId: "other" }),
      row("other"),
      row("parent"),
    ];
    expect(ids(nestSessions(rows))).toEqual(["other", "parent", "child"]);
  });

  test("falls back to the launcher when the subagent parent isn't listed", () => {
    const rows = [row("child", "gone", { launchedBySessionId: "work" }), row("work")];
    expect(ids(nestSessions(rows))).toEqual(["work", "child"]);
  });

  test("a launch loop still shows every row", () => {
    const rows = [launched("a", "b"), launched("b", "a")];
    expect(ids(nestSessions(rows)).sort()).toEqual(["a", "b"]);
  });
});

describe("groupNested", () => {
  test("folds every descendant under its top-level row", () => {
    const rows = [row("grandchild", "child"), row("other"), row("child", "root"), row("root")];
    expect(shape(groupNested(rows))).toEqual([
      ["other", []],
      ["root", ["child", "grandchild"]],
    ]);
  });

  test("an orphan subagent is its own top-level row", () => {
    expect(shape(groupNested([row("orphan", "gone")]))).toEqual([["orphan", []]]);
  });

  test("a coordinator's lanes and their reviewers fold under it", () => {
    const rows = [
      launched("lane-2-review", "lane-2"),
      launched("lane-2", "coord"),
      launched("lane-1", "coord"),
      row("coord", null, { origin: "user" }),
    ];
    expect(shape(groupNested(rows))).toEqual([["coord", ["lane-2", "lane-2-review", "lane-1"]]]);
  });
});

describe("splitBackground", () => {
  const split = (rows: ActiveSessionRow[]) => {
    const { foreground, background } = splitBackground(groupNested(rows));
    return { foreground: shape(foreground), background: shape(background) };
  };

  test("unlaunched automated sessions go to Background; legacy rows stay the user's", () => {
    expect(
      split([
        row("sync", null, { origin: "automated" }),
        row("mine", null, { origin: "user" }),
        row("legacy"),
      ]),
    ).toEqual({
      foreground: [
        ["mine", []],
        ["legacy", []],
      ],
      background: [["sync", []]],
    });
  });

  test("a launched session stays with its launcher, wherever the launcher is", () => {
    expect(
      split([
        launched("reviewer", "work"),
        row("work", null, { origin: "user" }),
        launched("lane", "bg-coord"),
        row("bg-coord", null, { origin: "automated" }),
      ]),
    ).toEqual({
      foreground: [["work", ["reviewer"]]],
      background: [["bg-coord", ["lane"]]],
    });
  });

  test("a launched session whose launcher isn't listed goes to Background", () => {
    expect(split([launched("orphan", "resolved-work")])).toEqual({
      foreground: [],
      background: [["orphan", []]],
    });
  });

  test("the user's session never folds into Background under an automated launcher", () => {
    // A sweep starts a session for the user to work in (--origin user).
    expect(
      split([
        row("for-user", null, { origin: "user", launchedBySessionId: "sweep" }),
        row("sweep", null, { origin: "automated" }),
      ]),
    ).toEqual({ foreground: [["for-user", []]], background: [["sweep", []]] });
  });

  test("a pinned automated session shows with the user's rows", () => {
    expect(split([row("watched", null, { origin: "automated", pinned: true })])).toEqual({
      foreground: [["watched", []]],
      background: [],
    });
  });
});

describe("nestedLabel", () => {
  test("names subagents and launched sessions apart", () => {
    expect(nestedLabel([row("s", "p")], 0)).toBe("1 subagent");
    expect(nestedLabel([row("s1", "p"), row("s2", "p")], 0)).toBe("2 subagents");
    expect(nestedLabel([launched("r", "p")], 0)).toBe("1 launched");
    expect(nestedLabel([row("s", "p"), launched("r1", "p"), launched("r2", "p")], 1)).toBe(
      "1 subagent · 2 launched · 1 running",
    );
  });
});
