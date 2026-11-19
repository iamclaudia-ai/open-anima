import { describe, expect, test } from "bun:test";
import { BACKGROUND_HOLD_MAX_MS } from "@anima/shared";
import type { AgentHostSessionInfo } from "../session-types";
import type { RuntimeStatus, SessionDisposition } from "../session-store";
import { RESOLVED_CLOSE_GRACE_MS, resolvedSessionsToClose } from "./resolved-closer";

const NOW = Date.parse("2026-11-06T05:00:00Z");
const MIN = 60_000;

function live(id: string, turnActive?: boolean, backgroundTasks?: number): AgentHostSessionInfo {
  return {
    id,
    cwd: "/tmp",
    model: "claude-opus-5-5",
    isActive: true,
    isProcessRunning: true,
    createdAt: "2026-11-06T00:00:00Z",
    lastActivity: "2026-11-06T00:00:00Z",
    healthy: true,
    stale: false,
    turnActive,
    backgroundTasks,
  };
}

function row(
  disposition: SessionDisposition,
  quietMs: number,
  runtimeStatus: RuntimeStatus = "idle",
) {
  return { disposition, runtimeStatus, lastActivity: new Date(NOW - quietMs).toISOString() };
}

describe("resolvedSessionsToClose", () => {
  test("closes resolved and archived sessions at rest past the grace", () => {
    const rows = {
      resolved: row("resolved", 10 * MIN),
      archived: row("archived", 10 * MIN),
      open: row("open", 10 * MIN),
      blocked: row("blocked", 10 * MIN),
    };
    const ids = resolvedSessionsToClose(
      Object.keys(rows).map((id) => live(id, false)),
      (id) => rows[id as keyof typeof rows] ?? null,
      NOW,
    );
    expect(ids).toEqual(["resolved", "archived"]);
  });

  test("leaves a just-resolved session to finish its reply", () => {
    const quiet = RESOLVED_CLOSE_GRACE_MS - MIN;
    expect(resolvedSessionsToClose([live("a", false)], () => row("resolved", quiet), NOW)).toEqual(
      [],
    );
  });

  test("never closes a session mid-turn", () => {
    expect(
      resolvedSessionsToClose([live("a", true)], () => row("resolved", 60 * MIN), NOW),
    ).toEqual([]);
  });

  test("with no turn state from the provider, trusts the row's runtime status", () => {
    const get = (id: string) =>
      id === "busy" ? row("resolved", 60 * MIN, "running") : row("resolved", 60 * MIN);
    expect(resolvedSessionsToClose([live("busy"), live("idle")], get, NOW)).toEqual(["idle"]);
  });

  test("skips sessions with no row", () => {
    expect(resolvedSessionsToClose([live("a", false)], () => null, NOW)).toEqual([]);
  });

  test("keeps a resolved session whose Monitor is still running, closes one without", () => {
    // The user marked both done an hour ago. One is a reviewer watcher whose
    // Monitor waits on CI between turns; the other has nothing left running.
    const sessions = [live("watching-ci", false, 1), live("finished", false, 0)];
    expect(resolvedSessionsToClose(sessions, () => row("resolved", 60 * MIN), NOW)).toEqual([
      "finished",
    ]);
  });

  test("closes it once the work ends and the grace passes", () => {
    // The Monitor's end woke the session for a turn; the grace counts from there.
    const ended = [live("watching-ci", false, 0)];
    const quiet = RESOLVED_CLOSE_GRACE_MS - MIN;
    expect(resolvedSessionsToClose(ended, () => row("resolved", quiet), NOW)).toEqual([]);
    expect(resolvedSessionsToClose(ended, () => row("resolved", 10 * MIN), NOW)).toEqual([
      "watching-ci",
    ]);
  });

  test("a day without a single turn outweighs a background count", () => {
    const stale = [live("a", false, 1)];
    expect(
      resolvedSessionsToClose(stale, () => row("resolved", BACKGROUND_HOLD_MAX_MS), NOW),
    ).toEqual(["a"]);
  });
});
