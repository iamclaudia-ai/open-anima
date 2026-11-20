/**
 * The CLI flags that carry the persona file and the per-session context.
 *
 * Older Claude Code (2.1.267, for one) refuses `--append-system-prompt` together
 * with `--append-system-prompt-file` and exits before the pane is usable, so
 * every combination here passes at most one append flag: in append mode the
 * persona and the context go into one merged file.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { animaDataDir } from "@anima/shared";

export interface SystemPromptInput {
  /** Absolute path to an existing persona file, if one is configured. */
  personaFile?: string;
  /** "replace" swaps out Claude Code's own system prompt; anything else appends. */
  mode?: "append" | "replace";
  /** Per-session context (memory bootstrap, time reminder). */
  context?: string;
  /** Writes the merged persona + context and returns its path. */
  writeMerged: (text: string) => string;
}

export function systemPromptArgs(input: SystemPromptInput): string[] {
  const context = input.context?.trim();
  const { personaFile } = input;

  if (!personaFile) return context ? ["--append-system-prompt", context] : [];

  if (input.mode === "replace") {
    return [
      "--system-prompt-file",
      personaFile,
      ...(context ? ["--append-system-prompt", context] : []),
    ];
  }

  if (!context) return ["--append-system-prompt-file", personaFile];

  const persona = readFileSync(personaFile, "utf8").trimEnd();
  return ["--append-system-prompt-file", input.writeMerged(`${persona}\n\n${context}\n`)];
}

/** Write a session's merged system prompt (owner-only) and return its path. */
export function writeSessionPromptFile(sessionId: string, text: string): string {
  const dir = join(animaDataDir(), "agent-host", "prompts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.md`);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
