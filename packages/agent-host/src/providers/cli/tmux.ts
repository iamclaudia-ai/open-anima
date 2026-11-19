/**
 * Minimal tmux helpers for the Claude CLI runtime.
 *
 * The runtime drives a real `claude` TUI living in a detached tmux session.
 * These are thin, synchronous wrappers around the `tmux` binary (input side);
 * the model stream comes back out-of-band via the proxy, not from the pane.
 */

import { execFileSync } from "node:child_process";
import { wrapperPaneName } from "../../pane-names";

/** POSIX single-quote a string for safe embedding in a shell command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8" }).toString();
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    return e.stdout ? e.stdout.toString() : "";
  }
}

export function hasSession(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** [binary, ...args] — quoted and run via the session's shell. */
  command: string[];
  /** Environment assignments prefixed onto the command (empty value clears). */
  env?: Record<string, string>;
}

/** `K=V ... 'bin' 'arg'...` — env assignments (empty value clears) + quoted argv. */
function buildCommandLine(command: string[], env?: Record<string, string>): string {
  const envPrefix = Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${sq(v)}`)
    .join(" ");
  return `${envPrefix} ${command.map(sq).join(" ")}`.trim();
}

export function newSession(opts: NewSessionOptions): void {
  const cmd = buildCommandLine(opts.command, opts.env);
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    opts.cwd,
    cmd,
  ]);
}

/**
 * Launch a command at the shell prompt of an existing session's pane.
 *
 * Used to relaunch `claude` when the pane is alive but the CLI died (crash, or a
 * manually re-created session) — unlike kill+new-session, this keeps any client
 * attached. `C-u` clears stray input first, then the line is typed and submitted.
 */
export function runInPane(name: string, command: string[], env?: Record<string, string>): void {
  const line = buildCommandLine(command, env);
  tmux(["send-keys", "-t", name, "C-u"]);
  tmux(["send-keys", "-t", name, "-l", line]);
  tmux(["send-keys", "-t", name, "Enter"]);
}

export function capturePane(name: string): string {
  return tmux(["capture-pane", "-t", name, "-p"]);
}

export function sendKey(name: string, key: string): void {
  tmux(["send-keys", "-t", name, key]);
}

/**
 * Bracketed-paste (possibly multi-line) text into the TUI input WITHOUT
 * submitting — loads it as a tmux buffer and pastes it (preserves newlines,
 * unlike `send-keys -l`). Use {@link submit} to send it.
 */
export function pasteText(name: string, text: string): void {
  tmux(["set-buffer", "--", text]);
  tmux(["paste-buffer", "-t", name, "-d", "-p"]);
}

/** Submit the TUI's current input line (Enter). */
export function submit(name: string): void {
  tmux(["send-keys", "-t", name, "Enter"]);
}

/** Paste text and submit it as one turn, after a short settle delay. */
export async function sendText(name: string, text: string): Promise<void> {
  pasteText(name, text);
  await new Promise((r) => setTimeout(r, 150));
  submit(name);
}

export function killSession(name: string): void {
  if (hasSession(name)) tmux(["kill-session", "-t", name]);
}

/**
 * Kill the tmux-wrap wrapper sessions that belong to a Claude session: its own
 * `<prefix>-wrapper-<id>` and every subagent's `<prefix>-wrapper-<id>-sub-<agentId>`.
 * A wrapper exists only to run that session's Bash commands, so it is garbage
 * the moment the session is closed. If the session is resumed, the hook simply
 * creates the wrapper again on its next command. Returns the names it killed.
 */
export function killWrapperSessions(sessionId: string): string[] {
  const base = wrapperPaneName(sessionId);
  const killed: string[] = [];
  for (const s of listTmuxSessions()) {
    if (s.name !== base && !s.name.startsWith(`${base}-sub-`)) continue;
    killSession(s.name);
    killed.push(s.name);
  }
  return killed;
}

export interface TmuxSessionInfo {
  name: string;
  /**
   * Last activity time, unix seconds: the later of the session's activity
   * (client input, attach) and its current window's (pane output). tmux only
   * moves `session_activity` for a client, so for a detached pane it stays at
   * the creation time no matter how much the pane prints.
   */
  activitySec: number;
  /** True when one or more clients are attached. */
  attached: boolean;
  /**
   * True when a tmux-wrap pane in it is running a command: marked
   * `@tmux-wrap-state busy` and not back at an interactive shell. A child that
   * is killed never resets the mark, but its pane returns to a login shell
   * (zsh), so the mark alone would keep a dead wrapper "busy" forever. The
   * child itself runs under bash, so bash still counts as busy.
   */
  busy: boolean;
}

/**
 * A pane's current working directory.
 *
 * Used to adopt a CLI session whose registry record was lost: `resume` needs a
 * cwd, and the pane already knows the one it was launched in.
 */
export function paneCurrentPath(name: string): string | null {
  const out = tmux(["display-message", "-p", "-t", name, "#{pane_current_path}"]).trim();
  return out || null;
}

/** Snapshot of every tmux session on this host (empty array if tmux is dead). */
export function listTmuxSessions(): TmuxSessionInfo[] {
  const sessions = tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_activity}\t#{window_activity}\t#{session_attached}",
  ]);
  if (!sessions.trim()) return [];
  const panes = tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{@tmux-wrap-state}\t#{pane_current_command}",
  ]);
  return parseTmuxSessions(sessions, panes);
}

/** Shells a finished tmux-wrap child leaves its pane in. */
const IDLE_SHELLS = new Set(["zsh", "-zsh", "sh", "fish"]);

/** Parse `list-sessions` and `list-panes -a` output (formats above). Exported for tests. */
export function parseTmuxSessions(sessionsOut: string, panesOut: string): TmuxSessionInfo[] {
  const busy = new Set<string>();
  for (const line of panesOut.split("\n")) {
    const [name, state, command] = line.split("\t");
    if (name && state === "busy" && !IDLE_SHELLS.has(command ?? "")) busy.add(name);
  }
  return sessionsOut
    .trim()
    .split("\n")
    .map((line) => {
      const [name, sessionActivity, windowActivity, attached] = line.split("\t");
      return {
        name: name ?? "",
        activitySec: Math.max(Number(sessionActivity) || 0, Number(windowActivity) || 0),
        attached: Number(attached) > 0,
        busy: busy.has(name ?? ""),
      };
    })
    .filter((s) => s.name);
}
