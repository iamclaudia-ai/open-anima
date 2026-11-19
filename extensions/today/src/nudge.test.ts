import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { createTodayExtension } from "./index";
import { canNudge, nudgeMessage, nudgeQuiet } from "./nudge";
import { applyCollection, getItem, setNudged, setTop } from "./store";
import { todayTestDb } from "./test-db";

const URL = "https://github.com/acme/shop/pull/105";
const pr = (state: string, more: Record<string, unknown> = {}) => ({
  section: "my_pr",
  status: "open",
  title: "#105 fix(auth): keep the redirect URL after login [ENG-106]",
  url: URL,
  meta: { state },
  ...more,
});

describe("nudge", () => {
  test("only your open PRs waiting on reviewers", () => {
    expect(canNudge(pr("awaiting_review"))).toBe(true);
    expect(canNudge(pr("draft"))).toBe(false);
    expect(canNudge(pr("ready"))).toBe(false);
    expect(canNudge(pr("awaiting_review", { status: "done" }))).toBe(false);
    expect(canNudge(pr("awaiting_review", { section: "review" }))).toBe(false);
  });

  test("a nudge keeps it off the picks for 3 calendar days (Friday → Monday)", () => {
    const nudged = {
      ...pr("awaiting_review"),
      nudgedAt: new Date(2026, 10, 13, 17, 0).toISOString(),
    };
    expect(nudgeQuiet(nudged, "2026-11-13")).toBe(true);
    expect(nudgeQuiet(nudged, "2026-11-15")).toBe(true);
    expect(nudgeQuiet(nudged, "2026-11-16")).toBe(false);
    expect(nudgeQuiet({ ...pr("awaiting_review"), nudgedAt: null }, "2026-11-13")).toBe(false);
    // Reviewed since (changes requested, approved…): it's your move again.
    expect(nudgeQuiet({ ...nudged, meta: { state: "changes_requested" } }, "2026-11-13")).toBe(
      false,
    );
  });

  test("a draft to paste: a plain ask, the PR's own title linked", () => {
    expect(nudgeMessage(pr("awaiting_review"))).toBe(
      `Could someone review this? [fix(auth): keep the redirect URL after login [ENG-106]](${URL})`,
    );
  });
});

test("today.nudge drafts the message, records when, and posts nothing", async () => {
  const db = todayTestDb();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const extension = createTodayExtension(
    { projects: [{ name: "shop", cwd: "/repo/shop", reviewChannel: "code-review" }] },
    { openDb: () => db, now: () => new Date("2026-11-13T20:00:00Z"), run: async () => "[]" },
  );
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
    on: () => () => {},
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return { sessions: [] };
    },
  } as unknown as ExtensionContext;
  await extension.start(ctx);
  const { meta, ...rest } = pr("awaiting_review");
  applyCollection(
    db,
    "shop:mine",
    "shop",
    [{ key: "pr:105", ...rest, section: "my_pr", meta }],
    "2026-11-13T19:00:00.000Z",
  );

  const result = (await extension.handleMethod("today.nudge", { key: "pr:105" })) as {
    draft: string;
    channel: string | null;
  };
  expect(result.draft).toBe(nudgeMessage(pr("awaiting_review")));
  expect(result.channel).toBe("code-review");
  await Bun.sleep(0);
  // No session, no prompt: nothing leaves the machine.
  const methods = calls.map(([method]) => method);
  expect(methods).not.toContain("session.create_session");
  expect(methods).not.toContain("session.send_prompt");
  expect(getItem(db, "pr:105")?.nudgedAt).toBe("2026-11-13T20:00:00.000Z");
  await extension.stop();
});

test("set_top leaves out a PR nudged in the last 3 days", () => {
  const db = todayTestDb();
  const { meta, ...rest } = pr("awaiting_review");
  applyCollection(
    db,
    "shop:mine",
    "shop",
    [
      { key: "pr:105", ...rest, section: "my_pr", meta },
      { key: "pr:101", ...rest, title: "#101 other", section: "my_pr", meta },
    ],
    "2026-11-13T19:00:00.000Z",
  );
  setNudged(db, "pr:105", new Date(2026, 10, 13, 17, 0).toISOString());
  const picks = [{ key: "pr:105" }, { key: "pr:101" }];
  expect(setTop(db, "2026-11-14", picks, "2026-11-14T13:00:00.000Z")).toEqual({
    set: 1,
    missing: [],
    quiet: ["pr:105"],
  });
  expect(getItem(db, "pr:101")?.topRank).toBe(1);
  expect(getItem(db, "pr:105")?.topDate).toBeNull();
  expect(setTop(db, "2026-11-16", picks, "2026-11-16T13:00:00.000Z").quiet).toEqual([]);
});
