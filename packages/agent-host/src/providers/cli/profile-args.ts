/**
 * Translate a session profile into Claude CLI flags.
 *
 * `yolo` keeps the historical `--dangerously-skip-permissions`; every other
 * profile runs under a real permission mode. A profile that limits MCP to
 * Anima's own server gets a per-session MCP config file: it carries the
 * gateway token, so it is written owner-only and passed by path, never inline
 * where `ps` would show it. A profile with no MCP gets `--strict-mcp-config`
 * and no config, so the CLI starts no MCP servers at all.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bypassesPermissions, type ResolvedProfile } from "../../profiles";
import { animaDataDir } from "@anima/shared";

/** Interactive tools Anima always denies: nobody is at a TUI to answer them. */
export const ALWAYS_DISALLOWED = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

export interface ExtensionMcpTarget {
  serverName: string;
  url: string;
  headers?: Record<string, string>;
}

export function profileCliArgs(profile: ResolvedProfile, mcpConfigPath?: string): string[] {
  const args = bypassesPermissions(profile)
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", profile.permissionMode];

  if (profile.tools !== undefined) args.push("--tools", profile.tools.join(","));
  if (profile.allowedTools?.length) args.push("--allowedTools", profile.allowedTools.join(","));
  const disallowed = [...ALWAYS_DISALLOWED, ...(profile.disallowedTools ?? [])];
  args.push("--disallowedTools", disallowed.join(","));
  if (profile.restricted) args.push("--restricted");

  if (profile.mcp === "anima-only") {
    if (!mcpConfigPath) {
      throw new Error(
        `Session profile ${profile.name} needs Anima's MCP server, but none is configured`,
      );
    }
    args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  } else if (profile.mcp === "none") {
    args.push("--strict-mcp-config");
  }
  return args;
}

/**
 * Write the per-session MCP config (owner-only) and return its path: Anima's
 * server, plus any extra servers the profile declares.
 */
export function writeSessionMcpConfig(
  sessionId: string,
  target: ExtensionMcpTarget,
  extraServers: Record<string, Record<string, unknown>> = {},
): string {
  const base = animaDataDir();
  const dir = join(base, "agent-host", "mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.json`);
  const config = {
    mcpServers: {
      ...extraServers,
      [target.serverName]: {
        type: "http",
        url: target.url,
        ...(target.headers ? { headers: target.headers } : {}),
      },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
