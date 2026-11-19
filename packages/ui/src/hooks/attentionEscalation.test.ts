import { describe, expect, test } from "bun:test";
import {
  ESCALATE_AFTER_MS,
  ESCALATE_BLOCKED_AFTER_MS,
  canEscalate,
  escalateAfterMs,
  isAwaitingAcknowledgement,
  isBlockedOnPrompt,
  type AttentionSession,
} from "./useAttentionSessions";

/**
 * Two kinds of waiting, two thresholds. A finished session can sit for fifteen
 * minutes — the work is done and nothing is lost. A session blocked on a modal
 * prompt makes no progress at all until someone answers, and not knowing
 * that is the entire failure the detection exists to fix.
 */
const session = (runtimeStatus: AttentionSession["runtimeStatus"]): AttentionSession => ({
  sessionId: "ses_1",
  workspaceId: "ws_1",
  workspaceName: "anima",
  cwd: "/repo",
  title: null,
  firstPrompt: "review the PR",
  runtimeStatus,
  disposition: "open",
  lastActivity: "2026-01-15T00:00:00.000Z",
  waitingSince: "2026-01-15T00:00:00.000Z",
  snoozedUntil: null,
  pinned: false,
});

describe("attention escalation", () => {
  test("the banner never escalates an automated session unless it's pinned", () => {
    expect(canEscalate(session("completed"))).toBe(true); // legacy: no origin
    expect(canEscalate({ ...session("completed"), origin: "user" })).toBe(true);
    expect(canEscalate({ ...session("completed"), origin: "automated" })).toBe(false);
    expect(canEscalate({ ...session("completed"), origin: "automated", pinned: true })).toBe(true);
  });

  test("a blocked session counts as waiting on a human", () => {
    expect(isAwaitingAcknowledgement(session("awaiting_approval"))).toBe(true);
    expect(isAwaitingAcknowledgement(session("awaiting_input"))).toBe(true);
    expect(isBlockedOnPrompt(session("awaiting_approval"))).toBe(true);
  });

  test("a finished session still counts, and isn't called blocked", () => {
    expect(isAwaitingAcknowledgement(session("completed"))).toBe(true);
    expect(isBlockedOnPrompt(session("completed"))).toBe(false);
  });

  test("a session stalled on an API error is blocked, and escalates like one", () => {
    expect(isBlockedOnPrompt(session("api_error"))).toBe(true);
    expect(isAwaitingAcknowledgement(session("api_error"))).toBe(true);
    expect(escalateAfterMs(session("api_error"))).toBe(ESCALATE_BLOCKED_AFTER_MS);
  });

  test("the reconnect sweep's quiet-pane `stalled` is not blocked", () => {
    expect(isBlockedOnPrompt(session("stalled"))).toBe(false);
  });

  test("a working session is not waiting on anyone", () => {
    expect(isAwaitingAcknowledgement(session("running"))).toBe(false);
    expect(isAwaitingAcknowledgement(session("idle"))).toBe(false);
  });

  test("blocked escalates far sooner than finished", () => {
    expect(escalateAfterMs(session("awaiting_approval"))).toBe(ESCALATE_BLOCKED_AFTER_MS);
    expect(escalateAfterMs(session("completed"))).toBe(ESCALATE_AFTER_MS);
    expect(ESCALATE_BLOCKED_AFTER_MS).toBeLessThan(ESCALATE_AFTER_MS);
  });

  test("blocked still waits long enough that answering in the pane never banners", () => {
    // A prompt answered in a couple of seconds should raise nothing at all.
    expect(ESCALATE_BLOCKED_AFTER_MS).toBeGreaterThan(10_000);
  });
});
