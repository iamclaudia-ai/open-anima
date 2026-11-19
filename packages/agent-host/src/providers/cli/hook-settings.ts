/**
 * The settings file every CLI session is launched with (`--settings`). It only
 * adds Anima's hooks: settings files merge, so the user's own hooks still run.
 *
 * - `Stop` (always): saves the CLI's registry of background work, so closing a
 *   finished session never kills work it is waiting on (`bin/stop-hook.ts`).
 * - `PermissionRequest` (with a gateway token): permission prompts answered
 *   from Anima (`bin/permission-hook.ts`).
 *
 * A running `claude` reads this file once, at launch: a session picks up a
 * change here only when it is relaunched.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_HOOK_TIMEOUT_SEC } from "./permission-hook";
import { animaDataDir } from "@anima/shared";

const BIN = join(import.meta.dir, "..", "..", "bin");
/** The Stop hook is a file write; it should never hold a turn's end for long. */
const STOP_HOOK_TIMEOUT_SEC = 10;

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** agent-host's state folder (`$ANIMA_DATA_DIR/agent-host`, default `~/.anima/agent-host`). */
export function agentHostDataDir(): string {
  return join(animaDataDir(), "agent-host");
}

/** Where the Stop hook saves each session's background-work snapshot. */
export function defaultBackgroundDir(): string {
  return join(agentHostDataDir(), "background");
}

export interface HookSettingsOptions {
  /** Install the PermissionRequest hook (needs the gateway token for its requests). */
  permission: boolean;
  /** Folder the Stop hook writes snapshots into. */
  backgroundDir: string;
  /** Folder for the settings file itself (default {@link agentHostDataDir}). */
  dir?: string;
  bun?: string;
  binDir?: string;
}

/** Write the settings file and return its path. */
export function writeHookSettings(options: HookSettingsOptions): string {
  const bun = options.bun ?? process.execPath;
  const binDir = options.binDir ?? BIN;
  const dir = options.dir ?? agentHostDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(options.backgroundDir, { recursive: true, mode: 0o700 });
  const command = (script: string, ...args: string[]): string =>
    [bun, join(binDir, script), ...args].map(sq).join(" ");
  const hooks: Record<string, unknown[]> = {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: command("stop-hook.ts", options.backgroundDir),
            timeout: STOP_HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ],
  };
  if (options.permission) {
    hooks.PermissionRequest = [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: command("permission-hook.ts"),
            timeout: PERMISSION_HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ];
  }
  const path = join(dir, "hook-settings.json");
  writeFileSync(path, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
