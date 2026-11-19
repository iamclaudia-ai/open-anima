import { describe, expect, test } from "bun:test";
import { awaitDrains, drainCapFromEnv } from "./drain";

function quietLog() {
  const lines: Array<{ level: string; msg: string; meta?: unknown }> = [];
  return {
    lines,
    info: (msg: string, meta?: unknown) => lines.push({ level: "info", msg, meta }),
    warn: (msg: string, meta?: unknown) => lines.push({ level: "warn", msg, meta }),
  };
}

describe("awaitDrains", () => {
  test("waits for every response when they finish inside the cap", async () => {
    const log = quietLog();
    const out = await awaitDrains(
      [
        { sessionId: "aaaaaaaa-1", inFlight: 1, done: Bun.sleep(20) },
        { sessionId: "bbbbbbbb-2", inFlight: 2, done: Bun.sleep(40) },
      ],
      1_000,
      log,
    );
    expect(out.cut).toEqual([]);
    expect(out.drained.sort()).toEqual(["aaaaaaaa-1", "bbbbbbbb-2"]);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(35);
    expect(log.lines.some((l) => l.level === "warn")).toBe(false);
  });

  test("names the sessions the cap cuts, and returns at the cap", async () => {
    const log = quietLog();
    const t0 = Date.now();
    const out = await awaitDrains(
      [
        { sessionId: "fast0000-1", inFlight: 1, done: Bun.sleep(10) },
        { sessionId: "slow0000-2", inFlight: 1, done: new Promise<void>(() => {}) },
      ],
      100,
      log,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.drained).toEqual(["fast0000-1"]);
    expect(out.cut).toEqual(["slow0000-2"]);
    const warn = log.lines.find((l) => l.level === "warn");
    expect(warn?.meta).toMatchObject({ cut: ["slow0000"], drained: ["fast0000"] });
  });

  test("nothing in flight returns at once without logging", async () => {
    const log = quietLog();
    const out = await awaitDrains([], 60_000, log);
    expect(out).toEqual({ drained: [], cut: [], elapsedMs: 0 });
    expect(log.lines).toEqual([]);
  });
});

describe("drainCapFromEnv", () => {
  test("reads a positive ANIMA_DRAIN_MS", () => {
    expect(drainCapFromEnv({ ANIMA_DRAIN_MS: "600000" })).toBe(600_000);
  });
  test("unset, junk, zero or negative mean no drain", () => {
    expect(drainCapFromEnv({})).toBe(0);
    expect(drainCapFromEnv({ ANIMA_DRAIN_MS: "soon" })).toBe(0);
    expect(drainCapFromEnv({ ANIMA_DRAIN_MS: "0" })).toBe(0);
    expect(drainCapFromEnv({ ANIMA_DRAIN_MS: "-5" })).toBe(0);
  });
});
