/**
 * Recovering an API give-up written before this agent-host started: the
 * restart cut the stream, Claude Code recorded the give-up while nobody was
 * tailing, and the new tail starts after it. Drives the private recovery path
 * against a real transcript file; no tmux, no proxy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NUDGE_DELAYS_MS, NUDGE_MARKER, RECOVER_MIN_DELAY_MS } from "./api-error-nudge";
import { SessionJsonlTail } from "./jsonl-tail";
import { ClaudeCliSession } from "./session";

interface Sse {
  type: string;
  stop_reason?: string;
  nudge?: { attempt: number; of: number; inMs: number };
  stalled?: boolean;
}

interface TestSession {
  on(event: "sse", listener: (e: Sse) => void): void;
  tail: SessionJsonlTail;
  _isStarted: boolean;
  _recoveredError: unknown;
  _nudgeTimer: ReturnType<typeof setTimeout> | null;
  _nudgeStreak: { attempts: number } | null;
  findRecoverableApiError(): unknown;
  recoverApiError(): void;
  endNudgeStreak(reason: string): void;
}

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "api-error-entry.jsonl"), "utf8");
const giveUpAt = (iso: string): string => FIXTURE.trim().replace("2026-11-03T22:41:08.408Z", iso);
const line = (o: unknown): string => JSON.stringify(o);
const prompt = (text: string): string => line({ type: "user", message: { content: text } });
const reply = line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
const turnEnd = line({ type: "system", subtype: "turn_duration" });

const sessions: TestSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) {
    s.endNudgeStreak("test_done");
    s.tail.stop();
  }
});

/** A started session whose tail began at the end of `transcript`. */
function started(transcript: string[]): { s: TestSession; sse: Sse[] } {
  const file = join(mkdtempSync(join(tmpdir(), "anima-recover-")), "session.jsonl");
  writeFileSync(file, `${transcript.join("\n")}\n`);
  const s = new ClaudeCliSession(
    "recover-test",
    { cwd: "/tmp/anima-recover-test", model: "claude-haiku-4-5" },
    true,
    {},
  ) as unknown as TestSession;
  s.tail = new SessionJsonlTail("/x", "recover-test", file);
  s.tail.start();
  s._isStarted = true;
  s._recoveredError = s.findRecoverableApiError();
  sessions.push(s);
  const sse: Sse[] = [];
  s.on("sse", (e) => sse.push(e));
  return { s, sse };
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe("recovering a give-up written before start", () => {
  test("closes the turn and schedules nudge 1, counted from when the error happened", () => {
    const { s, sse } = started([prompt("long task"), reply, giveUpAt(ago(10_000)), turnEnd]);
    s.recoverApiError();

    expect(sse.map((e) => e.type)).toEqual(["turn_stop", "api_error"]);
    expect(sse[0]?.stop_reason).toBe("api_error");
    const nudge = sse[1]?.nudge;
    expect(nudge?.attempt).toBe(1);
    // ~20s left of the 30s backoff, not a fresh 30s.
    expect(nudge?.inMs).toBeLessThanOrEqual((NUDGE_DELAYS_MS[0] ?? 0) - 9_000);
    expect(nudge?.inMs).toBeGreaterThan(RECOVER_MIN_DELAY_MS);
    expect(s._nudgeTimer).not.toBeNull();
  });

  test("picks up the streak where the transcript left it", () => {
    const nudge = prompt(`${NUDGE_MARKER} (connection lost). Check first, then continue.`);
    const { s, sse } = started([
      giveUpAt(ago(200_000)),
      turnEnd,
      nudge,
      giveUpAt(ago(5_000)),
      turnEnd,
    ]);
    s.recoverApiError();
    expect(sse.find((e) => e.type === "api_error")?.nudge?.attempt).toBe(2);
  });

  test("an exhausted streak is marked stalled instead of nudged again", () => {
    const nudge = prompt(`${NUDGE_MARKER} (connection lost).`);
    const { s, sse } = started([
      giveUpAt(ago(60_000)),
      nudge,
      giveUpAt(ago(50_000)),
      nudge,
      giveUpAt(ago(40_000)),
      nudge,
      giveUpAt(ago(5_000)),
    ]);
    s.recoverApiError();
    expect(sse.find((e) => e.type === "api_error")?.stalled).toBe(true);
    expect(s._nudgeTimer).toBeNull();
  });

  test("an error older than the nudge schedule is left alone", () => {
    const { s } = started([reply, giveUpAt(ago(60 * 60_000)), turnEnd]);
    expect(s._recoveredError).toBeNull();
  });

  test("a transcript that moved on after the error has nothing to recover", () => {
    const { s } = started([giveUpAt(ago(5_000)), turnEnd, prompt("continue")]);
    expect(s._recoveredError).toBeNull();
  });

  test("a real prompt before the deferred tick cancels the recovery", () => {
    const { s, sse } = started([giveUpAt(ago(5_000)), turnEnd]);
    expect(s._recoveredError).not.toBeNull();
    s.endNudgeStreak("prompt");
    s.recoverApiError();
    expect(sse).toEqual([]);
    expect(s._nudgeTimer).toBeNull();
  });
});
