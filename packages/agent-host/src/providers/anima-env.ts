/**
 * Environment that every agent session exports so tools running *inside* it can
 * identify themselves back to Anima.
 *
 * The `anima` CLI reads `$ANIMA_SESSION_ID` and auto-injects it as `sessionId`
 * into any method whose input schema declares that property
 * (`injectSessionIdFromEnv` in `packages/cli/src/index.ts`): it is the whole
 * reason a session can call `anima session …` without naming itself.
 *
 * It also carries which instance the session belongs to (see
 * {@link instanceSessionEnv}), so an `anima` command run inside a session of a
 * second instance talks to that instance, not to the one on the default ports.
 *
 * **Every provider must merge this into the environment of the process it
 * spawns.** Adding a new runtime (grok-code, opencode, …)? Call this — it is
 * the single place the contract lives. Omitting it does not fail loudly; it
 * degrades silently into "no session identity".
 */

import { DEFAULT_GATEWAY_PORT, DEFAULT_TMUX_PREFIX } from "@anima/shared";

/**
 * Instance variables passed through to sessions when agent-host has them. The
 * watchdog ones let `anima watchdog …` inside a session reach this instance's
 * watchdog and LaunchAgent, not the default instance's (port 30085,
 * `com.anima.watchdog`).
 */
const FORWARDED_VARS = [
  "ANIMA_HOME",
  "ANIMA_CONFIG",
  "ANIMA_DATA_DIR",
  "ANIMA_MEMORY_DIR",
  "ANIMA_GATEWAY_URL",
  "ANIMA_TMUX_PREFIX",
  "ANIMA_WATCHDOG_URL",
  "ANIMA_WATCHDOG_CONFIG",
  "ANIMA_WATCHDOG_PORT",
  "ANIMA_WATCHDOG_LABEL",
  "ANIMA_SKIP_CLAUDE_UPDATE",
] as const;

/**
 * The variables that point a session's tools at this instance.
 *
 * The CLI runtime's `claude` runs in a tmux pane, and a pane inherits the tmux
 * server's environment (whoever started tmux first), not agent-host's. Without
 * these, `anima` inside a second instance's session would read the default
 * config and reach the default gateway. Empty for a default instance.
 */
export function instanceSessionEnv(
  instance: { gatewayPort: number; tmuxPrefix: string },
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_VARS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  if (!out.ANIMA_GATEWAY_URL && instance.gatewayPort !== DEFAULT_GATEWAY_PORT) {
    out.ANIMA_GATEWAY_URL = `ws://localhost:${instance.gatewayPort}/ws`;
  }
  if (instance.tmuxPrefix !== DEFAULT_TMUX_PREFIX) {
    // For a PreToolUse wrapper hook: it should name its panes
    // `${ANIMA_TMUX_PREFIX:-anima}-wrapper-<session>` so this instance reaps them.
    out.ANIMA_TMUX_PREFIX = instance.tmuxPrefix;
  }
  return out;
}

let instanceEnv: Record<string, string> = {};

/** Set the instance variables every session gets (once, when agent-host starts). */
export function configureInstanceEnv(env: Record<string, string>): void {
  instanceEnv = { ...env };
}

export function animaSessionEnv(sessionId: string): Record<string, string> {
  return { ...instanceEnv, ANIMA_SESSION_ID: sessionId };
}

/**
 * {@link animaSessionEnv} merged onto the current process environment.
 *
 * For spawn APIs that *replace* rather than extend the child environment —
 * the Agent SDK's `env`, and `@openai/codex-sdk`, which documents "when
 * provided, the SDK will not inherit variables from `process.env`".
 */
export function animaSessionEnvWithProcess(
  sessionId: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...overrides, ...animaSessionEnv(sessionId) };
}
