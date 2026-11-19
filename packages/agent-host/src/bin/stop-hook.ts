#!/usr/bin/env bun
/**
 * Claude Code `Stop` hook for every Anima CLI session.
 *
 * At each turn's end the CLI hands Stop hooks its live registry of background
 * work (`background_tasks`, `session_crons`). This saves it as the session's
 * snapshot in the directory given as the first argument, where agent-host
 * reads it (`providers/cli/background-work.ts`). It never blocks the stop:
 * whatever happens, it prints nothing and exits 0.
 *
 *   bun stop-hook.ts <snapshot-dir>   (stdin: the hook input JSON)
 */
import {
  backgroundSnapshotPath,
  snapshotFromStopInput,
  writeBackgroundSnapshot,
} from "../providers/cli/background-work";

try {
  const dir = process.argv[2];
  const parsed = snapshotFromStopInput(JSON.parse(await Bun.stdin.text()), Date.now());
  const path = dir && parsed ? backgroundSnapshotPath(dir, parsed.sessionId) : null;
  if (path && parsed) writeBackgroundSnapshot(path, parsed.snapshot);
} catch {
  // A lost snapshot only costs freshness: the transcript still carries the changes.
}
process.exit(0);
