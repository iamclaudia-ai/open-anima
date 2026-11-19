/**
 * How full a session's context is, measured against its own model's window,
 * and when Claude Code's idle compaction will fire.
 *
 * Idle-compaction numbers were read from Claude Code 2.1.325's code (Nov 13,
 * 2026): it compacts an idle session only with a 1-hour prompt cache that is
 * still warm and at least `max(100K, CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ??
 * 200K)` tokens of context, at 0.9 of the cache's lifetime (54 minutes).
 * Observed firing 53.7–53.9 minutes idle (Oct 10–13, 2.1.296). Re-check them
 * when Claude Code changes how it compacts.
 */
import type { Usage } from "../types";

/** The window of a Claude model without a context variant. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The window a `[1m]` model id selects. */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

/** Below this much context Claude Code never compacts an idle session. */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;
/** 0.9 of the 1-hour prompt cache: when an idle session compacts. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60_000;
/** How long before that the composer starts counting down. */
export const IDLE_COUNTDOWN_LEAD_MS = 4 * 60_000;

/** Past this share of the window, compact by hand rather than wait. */
export const DANGER_FRACTION = 0.6;

/** The context window a model id selects: `[1m]` → 1M, otherwise 200K. */
export function contextWindowFor(model: string | null | undefined): number {
  return model && /\[1m\]\s*$/i.test(model) ? ONE_MILLION_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** Tokens the last model call carried in: everything that fills the window. */
export function contextTokens(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

/**
 * - `empty`: no context yet.
 * - `normal`: nothing to think about.
 * - `ready`: big enough that a long break compacts it (idle compaction's floor).
 * - `danger`: past 60% of the window; compact by hand now.
 */
export type ContextZone = "empty" | "normal" | "ready" | "danger";

export function contextZone(tokens: number, window: number): ContextZone {
  if (tokens <= 0) return "empty";
  if (tokens >= window * DANGER_FRACTION) return "danger";
  if (tokens >= IDLE_COMPACT_MIN_TOKENS) return "ready";
  return "normal";
}

/**
 * Milliseconds until idle compaction fires, while the countdown should show:
 * context at or over its floor, the session idle since `idleSince`, and within
 * the last four minutes before the fire point. Null otherwise, including past
 * the fire point (it either compacted or the cache went cold).
 */
export function idleCompactionRemainingMs(
  tokens: number,
  idleSince: number | null,
  now: number,
): number | null {
  if (idleSince === null || tokens < IDLE_COMPACT_MIN_TOKENS) return null;
  const remaining = idleSince + IDLE_COMPACT_AFTER_MS - now;
  if (remaining <= 0 || remaining > IDLE_COUNTDOWN_LEAD_MS) return null;
  return remaining;
}

/** `3:42` */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** `320K`, `1M`, `12.5K` */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
