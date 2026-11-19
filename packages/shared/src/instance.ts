/**
 * Where this Anima instance lives: its folders, ports and tmux namespace.
 *
 * Two instances can share a machine as long as they differ in all of these.
 * Every value is resolved per call from the environment, never at import, so a
 * test (or a second instance started with its own env) is never pointed at the
 * first instance's state by import order.
 *
 * | What                  | Env                     | Config key             | Default                            |
 * | --------------------- | ----------------------- | ---------------------- | ---------------------------------- |
 * | config folder         | `ANIMA_HOME`            | -                      | home folder                        |
 * | config file           | `ANIMA_CONFIG`          | -                      | `<home>/.anima/anima.json`         |
 * | watchdog config       | `ANIMA_WATCHDOG_CONFIG` | -                      | `<home>/.anima/watchdog.json`      |
 * | data folder           | `ANIMA_DATA_DIR`        | -                      | `~/.anima`                         |
 * | memory repo           | `ANIMA_MEMORY_DIR`      | -                      | `~/memory`                         |
 * | gateway port          | `ANIMA_GATEWAY_PORT`    | `gateway.port`         | 30086                              |
 * | agent-host port       | `ANIMA_AGENT_HOST_PORT` | `agentHost.port`       | 30087                              |
 * | watchdog port         | `ANIMA_WATCHDOG_PORT`   | `port` (watchdog.json) | 30085                              |
 * | tmux pane prefix      | `ANIMA_TMUX_PREFIX`     | `agentHost.tmuxPrefix` | `anima`                            |
 * | gateway the CLI uses  | `ANIMA_GATEWAY_URL`     | -                      | `ws://localhost:<gateway port>/ws` |
 * | watchdog the CLI uses | `ANIMA_WATCHDOG_URL`    | -                      | `http://localhost:<watchdog port>` |
 * | launchd label         | `ANIMA_WATCHDOG_LABEL`  | -                      | `com.anima.watchdog`               |
 *
 * `<home>` is the config folder. The data folder holds the database, logs,
 * agent-host state and extension stores. It is separate from the config folder
 * so an instance can keep its config in a repo and its data elsewhere; an
 * isolated instance sets both. The watchdog's service ports and health URLs
 * come only from watchdog.json, not from the port variables. The launchd label
 * is what `anima watchdog install|uninstall|reload` act on.
 *
 * Agent-host passes the instance variables it has into every session (plus
 * `ANIMA_SKIP_CLAUDE_UPDATE`, and a derived `ANIMA_GATEWAY_URL` / `ANIMA_TMUX_PREFIX`
 * for a non-default port or prefix), so `anima` inside a session reaches its own
 * instance (`packages/agent-host/src/providers/anima-env.ts`).
 *
 * Other variables the code reads:
 *
 * - Switches: `ANIMA_SKIP_CLAUDE_UPDATE=true` (the watchdog doesn't run
 *   `claude update` at start), `ANIMA_SKIP_ORPHAN_KILL=true` (the gateway
 *   doesn't kill leftover extension hosts at start), `ANIMA_PROJECT_DIR` (the
 *   checkout the watchdog runs services in when watchdog.json gives no `cwd`;
 *   default its own working folder), `ANIMA_AGENT_IDLE_STALE_MS` and
 *   `ANIMA_AGENT_IDLE_REAP_INTERVAL_MS` (agent-host's idle reaper, over
 *   `agentHost.idleStaleMs` / `reapIntervalMs`), `ANIMA_SIGN_IDENTITY` (the
 *   certificate `packages/watchdog/scripts/sign.sh` signs with).
 * - Set by Anima for the processes it starts, not by you: `ANIMA_SESSION_ID`
 *   (every session), `ANIMA_DRAIN_MS` (agent-host, from the watchdog's
 *   `drainMs`), `ANIMA_PERMISSION_HOOK_URL` / `ANIMA_PERMISSION_HOOK_TOKEN` (the
 *   CLI runtime's permission hook), `ANIMA_TASK_ID` / `ANIMA_EXECUTION_ID`
 *   (scheduler exec tasks), `ANIMA_MAIN_REPO` / `ANIMA_WORKTREE_PATH` /
 *   `ANIMA_SESSION_PROFILE` / `ANIMA_DEFAULT_WORKTREE_SCRIPT` (a worktree's
 *   bootstrap script).
 * - Tests and smoke scripts: `ANIMA_TEST_DATA_DIR` / `ANIMA_TEST_MEMORY_DIR`
 *   (`scripts/test-preload.ts`), `ANIMA_GATEWAY_HTTP`, `ANIMA_GATEWAY_WS` and
 *   `ANIMA_SMOKE_*` (`scripts/smoke.ts`, `scripts/e2e-smoke.ts`).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WATCHDOG_PORT = 30085;
export const DEFAULT_GATEWAY_PORT = 30086;
export const DEFAULT_AGENT_HOST_PORT = 30087;
export const DEFAULT_TMUX_PREFIX = "anima";

/** Anima's data folder (`$ANIMA_DATA_DIR`, default `~/.anima`): database, logs, state. */
export function animaDataDir(): string {
  return process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
}

/** `<data folder>/logs`. */
export function animaLogsDir(): string {
  return join(animaDataDir(), "logs");
}

/** A log file in `<data folder>/logs`. */
export function animaLogFile(name: string): string {
  return join(animaLogsDir(), name);
}

/** The folder that holds `.anima/anima.json` (`$ANIMA_HOME`, default the home folder). */
export function animaConfigHome(): string {
  return process.env.ANIMA_HOME || homedir();
}

/** A TCP port from an env var, or undefined when unset or not a valid port. */
export function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

const TMUX_PREFIX_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

/**
 * Validate a tmux pane prefix. Pane names are `<prefix>-claude-<id>` and
 * `<prefix>-wrapper-<id>`, so the prefix must be a plain word (letters, digits,
 * `_`, inner `-`) for the reaper to tell one instance's panes from another's.
 */
export function normalizeTmuxPrefix(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_TMUX_PREFIX;
  if (!TMUX_PREFIX_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid tmux prefix "${trimmed}": use letters, digits, "_" and inner "-" only (e.g. "open-anima")`,
    );
  }
  return trimmed;
}
