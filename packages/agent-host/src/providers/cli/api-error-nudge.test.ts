import { describe, expect, test } from "bun:test";
import {
  MAX_NUDGES,
  NUDGE_DELAYS_MS,
  NUDGE_MARKER,
  NudgeBreaker,
  RECOVER_MIN_DELAY_MS,
  checkNudgeReadiness,
  decideOnApiError,
  describeApiError,
  findPendingApiError,
  inputBoxState,
  isRetryableApiError,
  nudgeText,
  type NudgeReadiness,
  recoveredDelayMs,
} from "./api-error-nudge";
import type { ApiErrorInfo } from "./jsonl";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RULE = "─".repeat(120);

const connectionLost: ApiErrorInfo = {
  error: "server_error",
  apiError: "connection_failed",
  streamCutCause: "stale_connection",
  text: "API Error: Connection lost mid-response. The response above may be incomplete.",
};

describe("isRetryableApiError", () => {
  test("only server_error is retried", () => {
    expect(isRetryableApiError(connectionLost)).toBe(true);
    expect(isRetryableApiError({ error: "rate_limit", text: "API Error: rate limited" })).toBe(
      false,
    );
    expect(isRetryableApiError({ error: "authentication_failed", text: "Please run /login" })).toBe(
      false,
    );
    expect(isRetryableApiError({ text: "API Error: something new" })).toBe(false);
  });
});

describe("nudge text", () => {
  test("names the failure without the TUI boilerplate", () => {
    expect(describeApiError(connectionLost)).toBe("Connection lost mid-response");
    expect(
      describeApiError({ error: "server_error", text: "API Error: 502 proxy upstream error" }),
    ).toBe("502 proxy upstream error");
    expect(describeApiError({ error: "server_error", text: "" })).toBe("server_error");
  });

  test("starts with the marker and says to check before redoing", () => {
    const text = nudgeText(connectionLost);
    expect(text.startsWith(NUDGE_MARKER)).toBe(true);
    expect(text).toContain("(Connection lost mid-response)");
    expect(text).toContain("before redoing anything");
    expect(text).toContain("If the work was already finished, say so and stop.");
  });
});

describe("decideOnApiError", () => {
  test("a fresh retryable error schedules nudge 1 after the first delay", () => {
    expect(decideOnApiError(null, connectionLost)).toEqual({
      action: "nudge",
      delayMs: NUDGE_DELAYS_MS[0] ?? -1,
      attempt: 1,
      streak: { attempts: 0, lastError: connectionLost },
    });
  });

  test("each nudge that fails again backs off further", () => {
    const second = decideOnApiError({ attempts: 1, lastError: connectionLost }, connectionLost);
    expect(second).toMatchObject({ action: "nudge", delayMs: NUDGE_DELAYS_MS[1], attempt: 2 });
    const third = decideOnApiError({ attempts: 2, lastError: connectionLost }, connectionLost);
    expect(third).toMatchObject({ action: "nudge", delayMs: NUDGE_DELAYS_MS[2], attempt: 3 });
  });

  test("gives up once the streak has used every nudge", () => {
    expect(
      decideOnApiError({ attempts: MAX_NUDGES, lastError: connectionLost }, connectionLost),
    ).toEqual({ action: "give_up", reason: "exhausted", attempts: MAX_NUDGES });
  });

  test("a non-retryable error gives up at once, mid-streak or not", () => {
    const limit: ApiErrorInfo = { error: "rate_limit", text: "API Error: usage limit reached" };
    expect(decideOnApiError(null, limit)).toEqual({
      action: "give_up",
      reason: "not_retryable",
      attempts: 0,
    });
    expect(decideOnApiError({ attempts: 1, lastError: connectionLost }, limit)).toMatchObject({
      action: "give_up",
      reason: "not_retryable",
    });
  });
});

/** A give-up entry as Claude Code writes it (CLI v2.1.317). */
const GIVE_UP = readFileSync(join(import.meta.dir, "fixtures", "api-error-entry.jsonl"), "utf8")
  .trim()
  .replace("2026-11-03T22:41:08.408Z", "2026-11-03T22:50:00.000Z");
const prompt = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const toolResult = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
});
const reply = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
});
const turnEnd = JSON.stringify({ type: "system", subtype: "turn_duration" });
const snapshot = JSON.stringify({ type: "file-history-snapshot" });
const NUDGE = prompt(
  `${NUDGE_MARKER} (connection lost mid-response). Check what already happened…`,
);

describe("findPendingApiError", () => {
  test("a transcript ending on a give-up (then turn_duration) is pending, with its timestamp", () => {
    expect(findPendingApiError([prompt("do the thing"), reply, GIVE_UP, turnEnd, ""])).toEqual({
      info: connectionLost,
      timestamp: "2026-11-03T22:50:00.000Z",
      attempts: 0,
    });
  });

  test("anything the model or a person said after the give-up means it moved on", () => {
    expect(findPendingApiError([GIVE_UP, turnEnd, prompt("continue")])).toBeNull();
    expect(findPendingApiError([GIVE_UP, turnEnd, prompt("continue"), reply])).toBeNull();
    expect(
      findPendingApiError([
        GIVE_UP,
        JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "hi" }),
      ]),
    ).toBeNull();
    expect(
      findPendingApiError([
        GIVE_UP,
        JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } }),
      ]),
    ).toBeNull();
  });

  test("entries that aren't conversation don't hide the give-up", () => {
    expect(findPendingApiError([reply, GIVE_UP, turnEnd, snapshot])?.attempts).toBe(0);
  });

  test("counts the nudges already sent in this streak", () => {
    const lines = [prompt("long task"), reply, GIVE_UP, turnEnd, NUDGE, reply, GIVE_UP, turnEnd];
    expect(findPendingApiError(lines)?.attempts).toBe(1);
    expect(findPendingApiError([...lines, NUDGE, GIVE_UP, turnEnd])?.attempts).toBe(2);
  });

  test("a nudge whose turn completed closes the streak; a later give-up starts over", () => {
    const lines = [GIVE_UP, turnEnd, NUDGE, reply, toolResult, reply, turnEnd, reply, GIVE_UP];
    expect(findPendingApiError(lines)?.attempts).toBe(0);
  });

  test("a real prompt closes the streak", () => {
    expect(
      findPendingApiError([GIVE_UP, turnEnd, NUDGE, GIVE_UP, prompt("try again"), GIVE_UP])
        ?.attempts,
    ).toBe(0);
  });

  test("a nudge whose error fell outside the window still counts", () => {
    expect(findPendingApiError([NUDGE, GIVE_UP, turnEnd])?.attempts).toBe(1);
  });

  test("a subagent's give-up is not ours", () => {
    const sidechain = JSON.stringify({ ...JSON.parse(GIVE_UP), isSidechain: true });
    expect(findPendingApiError([reply, sidechain])).toBeNull();
  });

  test("empty or fragmentary input finds nothing", () => {
    expect(findPendingApiError([])).toBeNull();
    expect(findPendingApiError(["", '{"type":"assist'])).toBeNull();
  });
});

describe("recoveredDelayMs", () => {
  test("counts the backoff from when the error happened", () => {
    expect(recoveredDelayMs(30_000, 1_000, 11_000)).toBe(20_000);
    expect(recoveredDelayMs(120_000, 0, 60_000)).toBe(60_000);
  });

  test("never shorter than the settle time, even when overdue", () => {
    expect(recoveredDelayMs(30_000, 0, 600_000)).toBe(RECOVER_MIN_DELAY_MS);
    expect(recoveredDelayMs(30_000, 0, 28_000)).toBe(RECOVER_MIN_DELAY_MS);
  });

  test("a clock-skewed future timestamp waits the full delay", () => {
    expect(recoveredDelayMs(30_000, 10_000, 0)).toBe(30_000);
  });
});

describe("inputBoxState", () => {
  // The shape of an idle Claude Code pane.
  const idle = [
    "⏺ Done.",
    RULE,
    "❯ ",
    RULE,
    "  [Opus 5.5] Read: 220889 In: 2 Create: 1908 Total: 222799 Out: 3 Context: 22%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  test("a bare prompt between the rules is empty", () => {
    expect(inputBoxState(idle)).toBe("empty");
  });

  test("a non-breaking space after the glyph is still empty", () => {
    expect(inputBoxState(idle.replace("❯ ", "❯ "))).toBe("empty");
  });

  test("typed text is has_text", () => {
    expect(inputBoxState(idle.replace("❯ ", "❯ can you also"))).toBe("has_text");
  });

  test("multi-line input is has_text", () => {
    expect(inputBoxState(idle.replace("❯ ", "❯ first line\n  second line"))).toBe("has_text");
  });

  test("no input box (modal, half-painted pane) is unknown", () => {
    expect(inputBoxState("Do you trust the files in this folder?\n❯ 1. Yes\n  2. No")).toBe(
      "unknown",
    );
    expect(inputBoxState("")).toBe("unknown");
  });

  test("rules from a markdown table in scrollback don't count without a prompt line", () => {
    expect(inputBoxState(`${RULE}\n| a | b |\n${RULE}\nstatus`)).toBe("unknown");
  });
});

describe("checkNudgeReadiness", () => {
  const ready: NudgeReadiness = {
    closed: false,
    turnActive: false,
    modalOnScreen: false,
    paneAlive: true,
    claudeAlive: true,
    paneStable: true,
    input: "empty",
  };

  test("an idle, stable pane with an empty input box is ready", () => {
    expect(checkNudgeReadiness(ready)).toEqual({ ok: true });
  });

  test("something else taking over abandons the streak", () => {
    expect(checkNudgeReadiness({ ...ready, turnActive: true })).toMatchObject({
      outcome: "abandon",
      reason: "turn_in_flight",
    });
    expect(checkNudgeReadiness({ ...ready, modalOnScreen: true })).toMatchObject({
      outcome: "abandon",
    });
    expect(checkNudgeReadiness({ ...ready, closed: true })).toMatchObject({ outcome: "abandon" });
  });

  test("text in the input box is never typed over: give up", () => {
    expect(checkNudgeReadiness({ ...ready, input: "has_text" })).toMatchObject({
      outcome: "give_up",
      reason: "input_not_empty",
    });
  });

  test("a dead CLI gives up", () => {
    expect(checkNudgeReadiness({ ...ready, claudeAlive: false })).toMatchObject({
      outcome: "give_up",
    });
  });

  test("a repainting pane or a missing input box retries later", () => {
    expect(checkNudgeReadiness({ ...ready, paneStable: false })).toMatchObject({
      outcome: "retry_later",
    });
    expect(checkNudgeReadiness({ ...ready, input: "unknown" })).toMatchObject({
      outcome: "retry_later",
    });
  });
});

describe("NudgeBreaker", () => {
  function harness(probeResults: boolean[] = []) {
    let now = 1_000_000;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const breaker = new NudgeBreaker({
      tripSessions: 3,
      windowMs: 60_000,
      probeDelaysMs: [30_000, 120_000],
      spacingMs: 15_000,
      now: () => now,
      probe: async () => probeResults.shift() ?? false,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    });
    return {
      breaker,
      timers,
      advance: (ms: number) => {
        now += ms;
      },
      fireProbe: async () => {
        const timer = timers.shift();
        if (!timer) throw new Error("no probe scheduled");
        timer.fn();
        await Bun.sleep(0);
      },
    };
  }

  test("spaces nudges host-wide even when closed", () => {
    const { breaker, advance } = harness();
    expect(breaker.acquire()).toEqual({ ok: true });
    expect(breaker.acquire()).toEqual({ ok: false, waitMs: 15_000 });
    advance(15_000);
    expect(breaker.acquire()).toEqual({ ok: true });
  });

  test("one session failing repeatedly is not an outage", () => {
    const { breaker } = harness();
    breaker.recordError("a");
    breaker.recordError("a");
    breaker.recordError("a");
    expect(breaker.isOpen).toBe(false);
  });

  test("errors outside the window don't add up", () => {
    const { breaker, advance } = harness();
    breaker.recordError("a");
    breaker.recordError("b");
    advance(61_000);
    breaker.recordError("c");
    expect(breaker.isOpen).toBe(false);
  });

  test("several sessions failing together opens it and holds every nudge", () => {
    const { breaker, timers } = harness();
    breaker.recordError("a");
    breaker.recordError("b");
    breaker.recordError("c");
    expect(breaker.isOpen).toBe(true);
    expect(timers.map((t) => t.ms)).toEqual([30_000]);
    const held = breaker.acquire();
    expect(held.ok).toBe(false);
    expect(!held.ok && held.waitMs).toBe(31_000);
  });

  test("probes on the backoff until the API answers, then releases one at a time", async () => {
    const { breaker, timers, fireProbe, advance } = harness([false, true]);
    breaker.recordError("a");
    breaker.recordError("b");
    breaker.recordError("c");

    advance(30_000);
    await fireProbe(); // still down
    expect(breaker.isOpen).toBe(true);
    expect(timers.map((t) => t.ms)).toEqual([120_000]);

    advance(120_000);
    await fireProbe(); // answers
    expect(breaker.isOpen).toBe(false);
    expect(breaker.acquire()).toEqual({ ok: true });
    expect(breaker.acquire()).toEqual({ ok: false, waitMs: 15_000 });
  });
});
