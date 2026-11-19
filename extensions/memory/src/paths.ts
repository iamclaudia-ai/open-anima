/**
 * Where the memory extension keeps things. Every path is resolved when it is
 * used, never at import, and honors the environment, so a test run (which
 * points these at temp folders in scripts/test-preload.ts) can never reach
 * the running system's memory repo or database.
 *
 * - `ANIMA_MEMORY_DIR`: the memory repo (default `~/memory`).
 * - `ANIMA_DATA_DIR`: Anima's data folder (default `~/.anima`): the database,
 *   Scribe's working folder and its reasoning logs.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function memoryRoot(): string {
  return process.env.ANIMA_MEMORY_DIR || join(homedir(), "memory");
}

export function animaDataDir(): string {
  return process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
}

/** Scribe's working folder: its sessions run here (a workspace named `scribe`). */
export function scribeCwd(): string {
  return join(animaDataDir(), "scribe");
}

/** Transcripts handed to Scribe, one file per conversation. */
export function scribeTranscriptsDir(): string {
  return join(scribeCwd(), "transcripts");
}

/** Scribe's reasoning logs, one per conversation. */
export function scribeLogsDir(): string {
  return join(animaDataDir(), "memory", "scribe", "logs");
}

/** Create Scribe's folders. Called when the worker starts, not at import. */
export function ensureScribeDirs(): void {
  for (const dir of [scribeCwd(), scribeTranscriptsDir(), scribeLogsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}
