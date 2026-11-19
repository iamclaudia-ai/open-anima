/**
 * Wiring for the `PermissionRequest` hook: the per-session token its
 * requests carry and the shape of the request agent-host accepts. The settings
 * file that installs it is `hook-settings.ts`; the hook itself is
 * `packages/agent-host/src/bin/permission-hook.ts`; the state behind it is
 * `permission-requests.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PermissionRequestInput } from "./permission-requests";

/** Agent-host route the hook posts to. */
export const PERMISSION_HOOK_PATH = "/hooks/permission-request";

/**
 * How long Claude Code lets the hook wait, in seconds. Expiry only kills the
 * hook (the dialog stays, and the pane scraper takes it over), so this is set
 * long: a prompt with no countdown can wait for the user all evening.
 */
export const PERMISSION_HOOK_TIMEOUT_SEC = 6 * 60 * 60;

/** What claudeCommand needs to give a session the hook. */
export interface PermissionHookTarget {
  /** Full URL of {@link PERMISSION_HOOK_PATH} on this agent-host. */
  url: string;
  /** Secret the per-session tokens are derived from (the gateway token). */
  secret: string;
}

/**
 * The token a session's hook presents. Derived, not stored, so it survives an
 * agent-host restart: panes outlive agent-host and keep the env they launched
 * with. Bound to one session, so a session can only raise prompts for itself.
 */
export function permissionHookToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`anima-permission-hook:${sessionId}`).digest("hex");
}

export function verifyPermissionHookToken(
  secret: string,
  sessionId: string,
  offered: string | null,
): boolean {
  if (!offered) return false;
  const expected = Buffer.from(permissionHookToken(secret, sessionId));
  const actual = Buffer.from(offered);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Env vars the hook reads, set on the `claude` process (hooks inherit them). */
export function permissionHookEnv(
  target: PermissionHookTarget,
  sessionId: string,
): Record<string, string> {
  return {
    ANIMA_PERMISSION_HOOK_URL: target.url,
    ANIMA_PERMISSION_HOOK_TOKEN: permissionHookToken(target.secret, sessionId),
  };
}

/** A hook request body, validated. */
export interface PermissionHookRequest extends PermissionRequestInput {
  sessionId: string;
}

/** Parse the hook's POST body; null when it isn't one. */
export function parsePermissionHookRequest(body: unknown): PermissionHookRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !b.sessionId) return null;
  if (typeof b.requestId !== "string" || !/^[\w-]{8,64}$/.test(b.requestId)) return null;
  if (typeof input.tool_name !== "string" || !input.tool_name) return null;
  return {
    sessionId: b.sessionId,
    requestId: b.requestId,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    permissionMode: typeof input.permission_mode === "string" ? input.permission_mode : undefined,
  };
}
