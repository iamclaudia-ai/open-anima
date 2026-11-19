import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import type { ExtensionContext } from "@anima/shared";
import { collectedWithin, createTodayExtension } from "./index";
import { todayTestDb } from "./test-db";

/** A board with one GitHub repo, a fake `gh` and review-queue scripts, and a clock the test moves. */
function githubBoard() {
  let clock = Date.parse("2026-11-13T18:00:00Z");
  let remaining = 4000;
  let rateLimited = false;
  const ran: string[] = [];
  const extension = createTodayExtension(
    { projects: [{ name: "shop", cwd: "/repo/shop", github: { repos: ["acme/shop"] } }] },
    {
      openDb: todayTestDb,
      now: () => new Date(clock),
      run: async (argv) => {
        if (argv[0] === "gh") {
          const reset = Date.parse("2026-11-13T19:00:00Z") / 1000;
          return JSON.stringify({ limit: 5000, remaining, reset });
        }
        ran.push(basename(argv[0]!));
        if (rateLimited) {
          remaining = 0;
          throw new Error(`${argv[0]} exited 1: gh: API rate limit exceeded`);
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
  const refresh = (params: Record<string, unknown>) =>
    extension.handleMethod("today.refresh", params);
  return {
    extension,
    ran,
    refresh,
    start: async () => {
      await extension.start(ctx);
      await refresh({ maxAgeSeconds: 0 }); // joins the first pass start() kicked off
    },
    advance: (minutes: number) => (clock += minutes * 60_000),
    setRemaining: (n: number) => (remaining = n),
    setRateLimited: (on: boolean) => (rateLimited = on),
    paused: async () =>
      ((await extension.handleMethod("today.list", {})) as { githubPaused: unknown }).githubPaused,
  };
}

describe("GitHub collection budget", () => {
  test("the page's frequent refreshes leave GitHub alone for 5 minutes; Refresh doesn't", async () => {
    const h = githubBoard();
    await h.start();
    expect(h.ran).toEqual(["check-review-queue", "check-my-prs"]);

    h.advance(2);
    await h.refresh({ maxAgeSeconds: 60 });
    expect(h.ran).toHaveLength(2);

    await h.refresh({});
    expect(h.ran).toHaveLength(4);

    h.advance(5);
    await h.refresh({ maxAgeSeconds: 60 });
    expect(h.ran).toHaveLength(6);
    await h.extension.stop();
  });

  test("a low budget pauses GitHub until the reset, even for Refresh", async () => {
    const h = githubBoard();
    h.setRemaining(800);
    await h.start();
    expect(h.ran).toEqual([]);
    expect(await h.paused()).toEqual({ until: "2026-11-13T19:00:00.000Z", remaining: 800 });

    await h.refresh({});
    expect(h.ran).toEqual([]);

    h.advance(61);
    h.setRemaining(5000);
    await h.refresh({ maxAgeSeconds: 60 });
    expect(h.ran).toEqual(["check-review-queue", "check-my-prs"]);
    expect(await h.paused()).toBeNull();
    await h.extension.stop();
  });

  test("running out mid-pass pauses the rest instead of failing every refresh", async () => {
    const h = githubBoard();
    // The budget reads fine, then check-review-queue is what runs it out.
    h.setRateLimited(true);
    await h.start();
    expect(h.ran).toEqual(["check-review-queue"]);
    expect(await h.paused()).toMatchObject({ remaining: 0 });

    h.advance(2);
    await h.refresh({});
    expect(h.ran).toEqual(["check-review-queue"]);
    await h.extension.stop();
  });
});

const NOW = Date.parse("2026-11-12T20:30:00Z");
const ago = (seconds: number) => ({ at: new Date(NOW - seconds * 1000).toISOString() });

describe("collectedWithin", () => {
  test("fresh only when every source was collected inside the window", () => {
    const statuses = new Map([
      ["shop:linear", ago(30)],
      ["shop:ledger", ago(50)],
    ]);
    expect(collectedWithin(["shop:linear", "shop:ledger"], statuses, NOW, 60_000)).toBe(true);
    expect(collectedWithin(["shop:linear", "shop:ledger"], statuses, NOW, 40_000)).toBe(false);
  });

  test("a source never collected (just after start) is stale", () => {
    const statuses = new Map([["shop:linear", ago(5)]]);
    expect(collectedWithin(["shop:linear", "shop:ledger"], statuses, NOW, 60_000)).toBe(false);
  });

  test("a recently failed source counts as fresh, so page focus doesn't hammer it", () => {
    const statuses = new Map([
      ["shop:linear", { ...ago(10), ok: false, error: "Linear answered 500" }],
    ]);
    expect(collectedWithin(["shop:linear"], statuses, NOW, 60_000)).toBe(true);
  });
});
