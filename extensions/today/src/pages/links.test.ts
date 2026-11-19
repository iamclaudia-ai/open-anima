import { describe, expect, test } from "bun:test";
import { refLinker, sessionState } from "./links";

const board = [
  { key: "pr:acme/shop#141", url: "https://github.com/acme/shop/pull/141" },
  { key: "review:acme/shop#142", url: "https://github.com/acme/shop/pull/142" },
  {
    key: "pr:acme/forms#120",
    url: "https://github.com/acme/forms/pull/120",
  },
  {
    key: "linear:ENG-104",
    url: "https://linear.app/acme/issue/ENG-104/fix-the-login-redirect",
  },
  { key: "slack:C0123:1700.1", url: "https://acme.slack.com/archives/C0123/p17001" },
];

describe("refLinker", () => {
  const link = refLinker(board);

  test("links refs on the board to their items", () => {
    expect(link("#141 is approved and green, so merge it first.")).toEqual([
      { text: "#141", url: "https://github.com/acme/shop/pull/141" },
      " is approved and green, so merge it first.",
    ]);
    expect(link("Then #120's three comments, and ENG-104.")).toEqual([
      "Then ",
      { text: "#120", url: "https://github.com/acme/forms/pull/120" },
      "'s three comments, and ",
      { text: "ENG-104", url: "https://linear.app/acme/issue/ENG-104/fix-the-login-redirect" },
      ".",
    ]);
  });

  test("builds links for refs that already left the board", () => {
    expect(link("#123 merged and ENG-1 is done")).toEqual([
      { text: "#123", url: "https://github.com/acme/shop/pull/123" },
      " merged and ",
      { text: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" },
      " is done",
    ]);
  });

  test("leaves look-alikes alone", () => {
    expect(link("Your #1 priority, in UTF-8.")).toEqual(["Your #1 priority, in UTF-8."]);
    expect(refLinker([])("#141 and ENG-1")).toEqual(["#141 and ENG-1"]);
  });
});

describe("sessionState", () => {
  test("says what the session is doing", () => {
    expect(sessionState({ runtimeStatus: "running" })).toMatchObject({
      label: "Working",
      busy: true,
    });
    expect(sessionState({ runtimeStatus: "awaiting_input" })).toMatchObject({
      label: "Needs you",
      tone: "red",
    });
    expect(sessionState({ runtimeStatus: "awaiting_approval" }).label).toBe("Needs you");
    expect(sessionState({ runtimeStatus: "running", disposition: "blocked" }).label).toBe(
      "Needs you",
    );
  });

  test("a turn that ended waits on you, however it settled", () => {
    for (const runtimeStatus of ["idle", "stalled", "completed", "interrupted"]) {
      expect(sessionState({ runtimeStatus, disposition: "open" }).label).toBe("Your turn");
    }
    expect(sessionState({ runtimeStatus: "stalled", disposition: "needs_review" }).label).toBe(
      "Review it",
    );
  });

  test("a worktree still being made comes first", () => {
    expect(
      sessionState({ runtimeStatus: "idle", worktreeSetup: { state: "running" } }),
    ).toMatchObject({ label: "Setting up", busy: true });
    expect(sessionState({ runtimeStatus: "idle", worktreeSetup: { state: "failed" } }).tone).toBe(
      "red",
    );
  });

  test("a question it asked wins over whatever it's doing", () => {
    expect(sessionState({ runtimeStatus: "stalled", disposition: "blocked" }, true)).toMatchObject({
      label: "Needs you",
      tone: "purple",
    });
    expect(sessionState(undefined, true).label).toBe("Needs you");
  });

  test("a session marked done is still linked, quietly", () => {
    expect(sessionState(undefined)).toEqual({ label: "Session", tone: "gray", busy: false });
  });
});
