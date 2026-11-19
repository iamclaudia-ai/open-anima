/**
 * Which Claude account a CLI session runs on.
 *
 * Every launch goes through `src/bin/claude-for-folder`, which walks up from the
 * session's folder to the nearest `.claude-account` marker, exports that
 * account's token from the Keychain, and execs claude. A shell alias can use the
 * same script, so a terminal session and an Anima session in the same
 * folder land on the same account. This module only asks the script which
 * account a folder resolves to, so a launch can fail with the script's message
 * (a marker naming an account with no token) instead of a dead pane.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** The launcher script; it lives beside the hook scripts. */
export const CLAUDE_FOR_FOLDER = join(import.meta.dir, "..", "..", "bin", "claude-for-folder");

/** Long enough for a Keychain read, short enough not to stall a launch. */
const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * The account `cwd` resolves to: a marker's name, or `default` for Claude
 * Code's own login. Throws with the script's message when the account's token
 * is missing.
 */
export function resolveClaudeAccount(cwd: string, launcher: string = CLAUDE_FOR_FOLDER): string {
  try {
    return execFileSync(launcher, ["--resolve-account"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RESOLVE_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(stderr || `Couldn't resolve the Claude account for ${cwd}: ${String(error)}`);
  }
}
