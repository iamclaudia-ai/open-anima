import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { CHECK_MY_PRS, type MyPrRow } from "./collectors/github";
import { createTodayExtension } from "./index";
import type { TodayItem } from "./store";
import { todayTestDb } from "./test-db";

function myPrRow(number: number, repo: string): MyPrRow {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: false,
    updatedAt: "2026-11-17T12:00:00Z",
    headRefName: `b${number}`,
    baseRefName: "main",
    defaultBranch: "main",
    conflicts: false,
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
    parentApproved: true,
    waitingOn: null,
  };
}

/** shop always collected, plus whatever the org search finds; a fake `gh` and review-queue scripts. */
function orgBoard() {
  let clock = Date.parse("2026-11-17T18:00:00Z");
  /** Open PRs of yours, by repo: what both the search and check-my-prs see. */
  const open = new Map<string, number[]>([
    ["acme/shop", [1]],
    ["acme/forms", [148]],
  ]);
  let searchFails = false;
  const myPrRepos: string[] = [];
  const extension = createTodayExtension(
    {
      projects: [
        {
          name: "shop",
          cwd: "/repo/shop",
          github: { repos: ["acme/shop"], org: "acme" },
        },
      ],
    },
    {
      openDb: todayTestDb,
      now: () => new Date(clock),
      run: async (argv) => {
        if (argv[0] === "gh" && argv[1] === "search") {
          if (searchFails) throw new Error("gh exited 1: HTTP 502");
          expect(argv).toContain("acme");
          const mine = argv.includes("--author");
          const rows = mine ? [...open].flatMap(([repo, prs]) => prs.map(() => repo)) : [];
          return JSON.stringify(rows.map((nameWithOwner) => ({ repository: { nameWithOwner } })));
        }
        if (argv[0] === "gh") {
          return JSON.stringify({ limit: 5000, remaining: 4000, reset: clock / 1000 + 3600 });
        }
        const repo = argv[argv.indexOf("-R") + 1]!;
        if (argv[0] === CHECK_MY_PRS) {
          myPrRepos.push(repo);
          return JSON.stringify((open.get(repo) ?? []).map((n) => myPrRow(n, repo)));
        }
        return "[]";
      },
    },
  );
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    emit() {},
    on: () => () => {},
    call: async () => ({}),
  } as unknown as ExtensionContext;
  const refresh = () => extension.handleMethod("today.refresh", {});
  const items = async () =>
    (
      (await extension.handleMethod("today.list", { doneSince: "2026-01-01T00:00:00Z" })) as {
        items: TodayItem[];
      }
    ).items;
  return {
    extension,
    open,
    myPrRepos,
    refresh,
    items,
    start: async () => {
      await extension.start(ctx);
      await extension.handleMethod("today.refresh", { maxAgeSeconds: 0 });
    },
    advance: (minutes: number) => (clock += minutes * 60_000),
    setSearchFails: (on: boolean) => (searchFails = on),
  };
}

const statusOf = (items: TodayItem[], key: string) => items.find((i) => i.key === key)?.status;

describe("org repo discovery", () => {
  test("a repo with an open PR of yours is collected; once it has none, its items close", async () => {
    const h = orgBoard();
    await h.start();
    expect(h.myPrRepos.sort()).toEqual(["acme/forms", "acme/shop"]);
    expect(statusOf(await h.items(), "pr:acme/forms#148")).toBe("open");

    // It merges: the search stops listing the repo, and check-my-prs never runs there again.
    h.open.delete("acme/forms");
    h.myPrRepos.length = 0;
    h.advance(6);
    await h.refresh();
    expect(h.myPrRepos).toEqual(["acme/shop"]);
    const items = await h.items();
    expect(statusOf(items, "pr:acme/forms#148")).toBe("done");
    // shop is always collected, open PRs or not.
    expect(statusOf(items, "pr:acme/shop#1")).toBe("open");
    await h.extension.stop();
  });

  test("a failed search closes nothing and keeps collecting the repos it last found", async () => {
    const h = orgBoard();
    await h.start();
    h.setSearchFails(true);
    h.myPrRepos.length = 0;
    h.advance(6);
    await h.refresh();
    expect(h.myPrRepos.sort()).toEqual(["acme/forms", "acme/shop"]);
    expect(statusOf(await h.items(), "pr:acme/forms#148")).toBe("open");
    const list = (await h.extension.handleMethod("today.list", {})) as {
      collections: Record<string, { ok: boolean }>;
    };
    expect(list.collections["shop:discovery"]?.ok).toBe(false);
    await h.extension.stop();
  });
});
