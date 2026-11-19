/**
 * Pre-trust a session's folder in Claude Code's `~/.claude.json`.
 *
 * Claude Code asks "Is this a project you trust?" the first time it runs in a
 * folder, even under `--dangerously-skip-permissions`, and nobody is at an
 * Anima pane to answer it. Creating a session in a folder is the user saying they
 * trust it, so every launch records that first.
 *
 * How Claude Code (2.1.323) decides, measured with a probe repo: it looks for
 * `projects[<folder>].hasTrustDialogAccepted === true`, walking up from the
 * real path of its cwd, but **never past the git root**. So a trusted
 * `~/Projects` covers no repo inside it; a repo needs an entry of its own (a
 * worktree of a trusted repo is covered by the main repo's). That one key is
 * all it needs. The home folder is the exception: its trust is never read
 * from the file, so there is nothing to write for it.
 */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

/** The key Claude Code looks a folder up by: its real path. */
function trustKey(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/**
 * Mark `folder` trusted unless it already is. Returns true when it wrote.
 * Everything else in the file is kept as it was.
 */
export function trustWorkspace(folder: string, configPath = claudeConfigPath()): boolean {
  const key = trustKey(folder);
  if (key === trustKey(homedir())) return false;
  const config = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>)
    : {};
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[key]?.hasTrustDialogAccepted === true) return false;
  projects[key] = { ...projects[key], hasTrustDialogAccepted: true };
  config.projects = projects;
  // Claude Code rewrites this file often: write a sibling and rename over it,
  // so a reader never sees half a file.
  const temp = `${configPath}.anima-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, configPath);
  return true;
}
