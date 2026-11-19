/**
 * This instance's tmux pane names.
 *
 * Every pane agent-host creates, adopts or reaps carries the instance's prefix
 * (`agentHost.tmuxPrefix`, env `ANIMA_TMUX_PREFIX`, default "anima"):
 *  - `<prefix>-claude-<id>`: a CLI session's `claude` TUI.
 *  - `<prefix>-wrapper-<id>[-sub-<agentId>]`: the Bash wrapper panes a
 *    PreToolUse hook makes for that session (see `scripts/tmux-wrap.sh`).
 *
 * tmux has one server per user, so a second Anima on the same machine sees the
 * first one's panes. Matching only its own prefix is what keeps it from
 * adopting the other's sessions on start or reaping its panes as orphans.
 */

import { DEFAULT_TMUX_PREFIX, normalizeTmuxPrefix } from "@anima/shared";

let prefix = DEFAULT_TMUX_PREFIX;

/** Set the prefix (once, from config, when agent-host starts). */
export function configurePanePrefix(value: string | undefined): void {
  prefix = normalizeTmuxPrefix(value);
}

export function panePrefix(): string {
  return prefix;
}

/** `<prefix>-claude-`: the start of every CLI session pane's name. */
export function claudePanePrefix(): string {
  return `${prefix}-claude-`;
}

/** `<prefix>-wrapper-`: the start of every Bash wrapper pane's name. */
export function wrapperPanePrefix(): string {
  return `${prefix}-wrapper-`;
}

/** The pane a CLI session's `claude` runs in. */
export function claudePaneName(sessionId: string): string {
  return `${claudePanePrefix()}${sessionId}`;
}

/** A session's own wrapper pane (its subagents' add `-sub-<agentId>`). */
export function wrapperPaneName(sessionId: string): string {
  return `${wrapperPanePrefix()}${sessionId}`;
}
