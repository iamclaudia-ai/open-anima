/**
 * Which tmux panes the orphan reaper may kill, and why.
 *
 * Two kinds of pane belong to this instance (`pane-names.ts`; `<p>` is its
 * prefix, "anima" by default):
 *  - `<p>-claude-<id>`: a CLI session's `claude` TUI.
 *  - `<p>-wrapper-<id>[-sub-<agentId>]`: the tmux-wrap PreToolUse hook's
 *    sessions, where that Claude session (or one of its subagents) runs Bash.
 *
 * Panes with any other prefix belong to another instance (or to nobody) and
 * are never touched.
 *
 * A pane is never reaped while a client is attached or while a wrapper pane is
 * running a command. Beyond that, how long it may sit quiet depends on whether
 * its owner is still alive:
 *  - A CLI pane is reaped only when its session is untracked *and* its `claude`
 *    process is gone. "Untracked" alone is not evidence: the registry is a cache,
 *    empty after a crash, and reaping on that signal once killed live sessions
 *    mid-conversation. A running `claude` is ground truth.
 *  - A wrapper whose owner is gone has nothing left to run commands for, so it
 *    goes after a short grace instead of the full idle threshold. The grace,
 *    rather than zero, covers a session between turns whose `claude` is
 *    restarting. If the owner comes back, the hook recreates the wrapper.
 *  - A subagent's wrapper is done when the subagent is, which the parent's
 *    liveness can't tell us, so it goes after SUBAGENT_PANE_STALE_MS.
 */

import type { TmuxSessionInfo } from "./providers/cli/tmux";
import { claudePanePrefix, wrapperPanePrefix } from "./pane-names";

/** A subagent's wrapper idle this long is treated as finished. */
export const SUBAGENT_PANE_STALE_MS = 15 * 60 * 1000;
/** A wrapper whose Claude session is gone is reaped after this much quiet. */
export const ORPHAN_WRAPPER_STALE_MS = 5 * 60 * 1000;

export type ReapKind = "claude-untracked" | "wrapper" | "subagent-wrapper" | "orphan-wrapper";

export interface ReapContext {
  nowSec: number;
  /** The full idle threshold (`agentHost.idleStaleMs`). */
  staleMs: number;
  /** agent-host is tracking this session. */
  isTracked: (sessionId: string) => boolean;
  /** A `claude` process for this session is running. */
  claudeAlive: (sessionId: string) => boolean;
}

/** Why `pane` should be reaped now, or null to keep it. */
export function reapVerdict(pane: TmuxSessionInfo, ctx: ReapContext): ReapKind | null {
  const CLAUDE_PREFIX = claudePanePrefix();
  const WRAPPER_PREFIX = wrapperPanePrefix();
  const isClaude = pane.name.startsWith(CLAUDE_PREFIX);
  const isWrapper = pane.name.startsWith(WRAPPER_PREFIX);
  if (!isClaude && !isWrapper) return null;
  if (pane.attached || pane.busy) return null;

  let kind: ReapKind;
  let limitMs: number;
  if (isClaude) {
    const sessionId = pane.name.slice(CLAUDE_PREFIX.length);
    if (ctx.isTracked(sessionId) || ctx.claudeAlive(sessionId)) return null;
    kind = "claude-untracked";
    limitMs = ctx.staleMs;
  } else {
    const rest = pane.name.slice(WRAPPER_PREFIX.length);
    const subAt = rest.indexOf("-sub-");
    const ownerId = subAt >= 0 ? rest.slice(0, subAt) : rest;
    const ownerGone = !ctx.isTracked(ownerId) && !ctx.claudeAlive(ownerId);
    const isSubagent = subAt >= 0;
    limitMs = Math.min(
      ctx.staleMs,
      isSubagent ? SUBAGENT_PANE_STALE_MS : ctx.staleMs,
      ownerGone ? ORPHAN_WRAPPER_STALE_MS : ctx.staleMs,
    );
    kind = ownerGone ? "orphan-wrapper" : isSubagent ? "subagent-wrapper" : "wrapper";
  }

  if (ctx.nowSec - pane.activitySec < limitMs / 1000) return null;
  return kind;
}
