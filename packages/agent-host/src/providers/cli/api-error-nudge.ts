/**
 * Nudging a CLI session that Claude Code gave up on.
 *
 * When the API connection fails mid-turn, Claude Code retries on its own, then
 * gives up: it writes a synthetic `isApiErrorMessage` entry to the transcript,
 * prints "API Error: Connection lost mid-response…", and goes idle. Nothing is
 * waiting on a human, but nothing will happen until someone types "continue".
 * Unattended sessions (handoff chains, scheduled jobs, overnight runs)
 * sit there silently.
 *
 * The policy here:
 *   - Only `error: "server_error"` is retried (connection lost, 502 upstream,
 *     server error mid-response, connection refused). Rate limits, auth, prompt
 *     too long and anything unrecognized need a person, so they go straight to
 *     the banner instead. Allow-list, because the other `error` values are
 *     unverified (none occurred on the dev machine).
 *   - At most {@link MAX_NUDGES} nudges per error streak, spaced by
 *     {@link NUDGE_DELAYS_MS}. A completed turn or a real prompt ends the streak.
 *   - A nudge only goes into a pane that is provably at rest with an empty input
 *     box. Text in the box means someone is (or was) typing there, and we never
 *     type over a human.
 *   - Host-wide, {@link NudgeBreaker} treats "several sessions failed at once"
 *     as one outage: it stops nudging, probes the API on a backoff, and once the
 *     probe answers lets nudges through one at a time.
 *
 * Everything that decides is pure (or takes its clock and probe as arguments),
 * so the session wiring in ./session.ts stays a thin adapter.
 */

import { animaLogFile, createLogger } from "@anima/shared";
import { type ApiErrorInfo, classifyEntry } from "./jsonl";

const log = createLogger("ApiErrorNudge", animaLogFile("agent-host.log"));

/** Wait before nudge 1, 2, 3. Long enough for a blip to clear, short enough to matter. */
export const NUDGE_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
export const MAX_NUDGES = NUDGE_DELAYS_MS.length;

/**
 * How every nudge starts. The session ignores its own nudge's `user_prompt` by
 * this prefix, so sending a nudge doesn't count as "a real prompt" and end the
 * streak it belongs to.
 */
export const NUDGE_MARKER = "[Anima] Your last response was cut off by an API error";

/** Only failures a retry can fix. See the module comment for why it's an allow-list. */
export function isRetryableApiError(info: ApiErrorInfo): boolean {
  return info.error === "server_error";
}

/** Short human name for the failure: the TUI's text minus its "API Error:" prefix. */
export function describeApiError(info: ApiErrorInfo): string {
  const text = info.text
    .replace(/^API Error:\s*/i, "")
    .replace(/\s*The response above may be incomplete\.?\s*$/i, "")
    .trim();
  return text.replace(/\.$/, "") || info.apiError || info.error || "unknown error";
}

/**
 * The prompt a nudge sends. Says what it is, and warns against redoing finished
 * work. The last sentence matters: a live test nudged a session whose task was
 * done, and with nothing to continue, it invented work.
 */
export function nudgeText(info: ApiErrorInfo): string {
  return (
    `${NUDGE_MARKER} (${describeApiError(info)}). ` +
    "Check what already happened (tool calls may have finished before the cut) before redoing anything, " +
    "then continue where you left off. If the work was already finished, say so and stop."
  );
}

export interface NudgeStreak {
  /** Nudges already sent in this streak. */
  attempts: number;
  lastError: ApiErrorInfo;
}

export type ApiErrorDecision =
  | { action: "nudge"; delayMs: number; attempt: number; streak: NudgeStreak }
  | { action: "give_up"; reason: "not_retryable" | "exhausted"; attempts: number };

/** What to do about an API give-up, given the streak it lands in (null = none open). */
export function decideOnApiError(streak: NudgeStreak | null, info: ApiErrorInfo): ApiErrorDecision {
  const attempts = streak?.attempts ?? 0;
  if (!isRetryableApiError(info)) return { action: "give_up", reason: "not_retryable", attempts };
  if (attempts >= MAX_NUDGES) return { action: "give_up", reason: "exhausted", attempts };
  return {
    action: "nudge",
    delayMs: NUDGE_DELAYS_MS[attempts] ?? NUDGE_DELAYS_MS[NUDGE_DELAYS_MS.length - 1] ?? 0,
    attempt: attempts + 1,
    streak: { attempts, lastError: info },
  };
}

/**
 * How old a give-up found at startup can be and still get nudged. The whole
 * 3-nudge schedule spans ~12.5 minutes; past that, the live path would have
 * finished with it one way or another.
 */
export const RECOVER_MAX_AGE_MS = 15 * 60_000;
/** Shortest wait before nudging a recovered give-up, so the re-adopted pane settles. */
export const RECOVER_MIN_DELAY_MS = 5_000;

/** A give-up the transcript ends on, plus the streak it belongs to. */
export interface PendingApiError {
  info: ApiErrorInfo;
  timestamp?: string;
  /** Nudges already sent in this streak, counted from the transcript. */
  attempts: number;
}

/**
 * Did the transcript end on an API give-up nobody answered?
 *
 * Claude Code writes the give-up the instant the stream dies. When agent-host
 * itself is what died (a restart cuts every stream it proxies), the entry lands
 * while nobody is tailing, and the next agent-host starts tailing after it. So
 * on start we read the transcript's last entries (oldest first) and rebuild the
 * streak the way the live path would have:
 *
 *   - an API error opens a streak (or extends the open one);
 *   - our own nudge prompt counts an attempt;
 *   - a real prompt, an interrupt or a real queued prompt closes it;
 *   - `turn_duration` closes it when the turn ended on model output rather
 *     than an error (a completed turn).
 *
 * Pending only when the last meaningful entry is the error itself: any prompt
 * or model output after it means the session already moved on.
 */
export function findPendingApiError(lines: Iterable<string>): PendingApiError | null {
  let streak = null as { attempts: number } | null;
  let pending: PendingApiError | null = null;
  let endedOnError = false;
  for (const line of lines) {
    const entry = classifyEntry(line);
    if (!entry) continue;
    switch (entry.kind) {
      case "api_error": {
        const { kind: _kind, timestamp, ...info } = entry;
        streak ??= { attempts: 0 };
        pending = { info, timestamp, attempts: streak.attempts };
        endedOnError = true;
        break;
      }
      case "user_prompt":
        // A nudge implies an open streak, even one whose error fell outside the window.
        streak = entry.text.startsWith(NUDGE_MARKER)
          ? { attempts: (streak?.attempts ?? 0) + 1 }
          : null;
        pending = null;
        endedOnError = false;
        break;
      case "enqueue":
        if (!entry.content.startsWith(NUDGE_MARKER)) streak = null;
        pending = null;
        endedOnError = false;
        break;
      case "interrupt":
        streak = null;
        pending = null;
        endedOnError = false;
        break;
      case "assistant":
        pending = null;
        endedOnError = false;
        break;
      case "turn_end":
        if (!endedOnError) streak = null;
        break;
      default:
        break;
    }
  }
  return pending;
}

/** The backoff for a recovered give-up, counted from when it happened. */
export function recoveredDelayMs(delayMs: number, errorAt: number, now: number): number {
  return Math.max(RECOVER_MIN_DELAY_MS, delayMs - Math.max(0, now - errorAt));
}

/**
 * The input box, read from a pane capture.
 *
 * The TUI draws it as a prompt line between two horizontal rules, with the
 * status bar below:
 *
 *     ──────────────────────
 *     ❯
 *     ──────────────────────
 *       [Opus 5.5] …
 *       ⏵⏵ bypass permissions on
 *
 * `empty` only when every line between the last two rules is the bare prompt
 * glyph (or blank). Anything else typed there is `has_text`, and no rules at
 * all (a modal, a half-painted pane) is `unknown`.
 */
export function inputBoxState(pane: string): "empty" | "has_text" | "unknown" {
  const lines = pane.split("\n");
  const rules: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s*─{20,}\s*$/.test(line)) rules.push(i);
  });
  if (rules.length < 2) return "unknown";
  const top = rules[rules.length - 2] ?? 0;
  const bottom = rules[rules.length - 1] ?? 0;
  const inside = lines.slice(top + 1, bottom).map((line) => line.trim());
  // The box is recognized by its prompt line, typed into or not.
  if (!inside.some((line) => /^[❯>](\s|$)/.test(line))) return "unknown";
  return inside.every((line) => line === "" || /^[❯>]$/.test(line)) ? "empty" : "has_text";
}

export interface NudgeReadiness {
  closed: boolean;
  turnActive: boolean;
  modalOnScreen: boolean;
  paneAlive: boolean;
  claudeAlive: boolean;
  /** Pane held still across several captures (nobody typing, nothing repainting). */
  paneStable: boolean;
  input: "empty" | "has_text" | "unknown";
}

/**
 * Can a nudge go in right now?
 *
 * - `abandon`: something else took over (a turn started, a modal owns the
 *   keyboard, the session closed). Drop the streak quietly; whatever took over
 *   reports its own state.
 * - `give_up`: we can't nudge and nobody else will notice. Mark it stalled.
 * - `retry_later`: transient (the pane is repainting). Try again shortly
 *   without spending an attempt.
 */
export type NudgeGate =
  | { ok: true }
  | { ok: false; outcome: "abandon" | "give_up" | "retry_later"; reason: string };

export function checkNudgeReadiness(r: NudgeReadiness): NudgeGate {
  if (r.closed) return { ok: false, outcome: "abandon", reason: "session_closed" };
  if (r.turnActive) return { ok: false, outcome: "abandon", reason: "turn_in_flight" };
  if (r.modalOnScreen) return { ok: false, outcome: "abandon", reason: "modal_prompt" };
  if (!r.paneAlive || !r.claudeAlive)
    return { ok: false, outcome: "give_up", reason: "cli_not_running" };
  if (!r.paneStable) return { ok: false, outcome: "retry_later", reason: "pane_not_stable" };
  if (r.input === "has_text") return { ok: false, outcome: "give_up", reason: "input_not_empty" };
  if (r.input === "unknown")
    return { ok: false, outcome: "retry_later", reason: "input_box_not_found" };
  return { ok: true };
}

// ── Host-wide breaker ────────────────────────────────────────

export interface NudgeBreakerOptions {
  /** Distinct sessions failing within `windowMs` that count as an outage. */
  tripSessions?: number;
  windowMs?: number;
  /** Probe delays while open; the last one repeats. */
  probeDelaysMs?: readonly number[];
  /** Minimum gap between any two nudges on this host, so a recovery releases sessions one by one. */
  spacingMs?: number;
  now?: () => number;
  /** True when the API answers at all (any non-5xx response). */
  probe?: () => Promise<boolean>;
  /** Timer hook for tests. */
  setTimer?: (fn: () => void, ms: number) => void;
  onChange?: (state: { open: boolean; reason: string }) => void;
}

/** Reachability, not health: any answer below 500 means the network and the API are back. */
export async function probeAnthropicApi(): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

export class NudgeBreaker {
  private readonly tripSessions: number;
  private readonly windowMs: number;
  private readonly probeDelaysMs: readonly number[];
  private readonly spacingMs: number;
  private readonly now: () => number;
  private readonly probe: () => Promise<boolean>;
  private readonly setTimer: (fn: () => void, ms: number) => void;
  private readonly onChange?: (state: { open: boolean; reason: string }) => void;

  private recent: Array<{ sessionId: string; at: number }> = [];
  private open = false;
  private probeIndex = 0;
  private nextProbeAt = 0;
  private nextGrantAt = 0;

  constructor(options: NudgeBreakerOptions = {}) {
    this.tripSessions = options.tripSessions ?? 3;
    this.windowMs = options.windowMs ?? 60_000;
    this.probeDelaysMs = options.probeDelaysMs ?? NUDGE_DELAYS_MS;
    this.spacingMs = options.spacingMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? probeAnthropicApi;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
      });
    this.onChange = options.onChange;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** A retryable API failure in `sessionId`. Opens the breaker when enough sessions fail together. */
  recordError(sessionId: string): void {
    const now = this.now();
    this.recent = this.recent.filter((e) => now - e.at < this.windowMs);
    this.recent.push({ sessionId, at: now });
    if (this.open) return;
    const distinct = new Set(this.recent.map((e) => e.sessionId)).size;
    if (distinct < this.tripSessions) return;
    this.open = true;
    this.probeIndex = 0;
    this.onChange?.({
      open: true,
      reason: `${distinct} sessions failed within ${this.windowMs}ms`,
    });
    this.scheduleProbe();
  }

  /** May a session nudge now? If not, how long until it should ask again. */
  acquire(): { ok: true } | { ok: false; waitMs: number } {
    const now = this.now();
    if (this.open) return { ok: false, waitMs: Math.max(1_000, this.nextProbeAt - now + 1_000) };
    if (now < this.nextGrantAt) return { ok: false, waitMs: this.nextGrantAt - now };
    this.nextGrantAt = now + this.spacingMs;
    return { ok: true };
  }

  private scheduleProbe(): void {
    const delay =
      this.probeDelaysMs[Math.min(this.probeIndex, this.probeDelaysMs.length - 1)] ?? 60_000;
    this.nextProbeAt = this.now() + delay;
    this.setTimer(() => void this.runProbe(), delay);
  }

  private async runProbe(): Promise<void> {
    if (!this.open) return;
    if (await this.probe()) {
      this.open = false;
      this.recent = [];
      // The first released session goes right away; the rest follow at `spacingMs`.
      this.nextGrantAt = 0;
      this.onChange?.({ open: false, reason: "probe answered" });
      return;
    }
    this.probeIndex++;
    this.scheduleProbe();
  }
}

/** The one breaker every CLI session on this agent-host shares. */
export const sharedNudgeBreaker = new NudgeBreaker({
  onChange: ({ open, reason }) =>
    open
      ? log.warn("Nudge breaker open: holding all API-error nudges", { reason })
      : log.info("Nudge breaker closed: releasing nudges one at a time", { reason }),
});
