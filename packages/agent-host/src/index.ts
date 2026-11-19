#!/usr/bin/env bun
/**
 * Agent Host server entrypoint.
 *
 * Delegates HTTP/WS serving and message routing to createAgentHostServer(),
 * then layers process-level startup/shutdown concerns (force lock clearing,
 * idle session reap).
 */

import {
  animaDataDir,
  animaLogFile,
  createLogger,
  ensureToken,
  flushLogs,
  loadConfig,
} from "@anima/shared";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createAgentHostServer } from "./server";
import { drainCapFromEnv } from "./drain";
import { killSession, listTmuxSessions } from "./providers/cli/tmux";
import { liveness } from "./providers/cli/liveness";
import { reapVerdict } from "./tmux-reaper";

const log = createLogger("AgentHost", animaLogFile("agent-host.log"));

const FORCE_STARTUP = process.argv.includes("--force");

function parseMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

// The gateway token authenticates every connection and signs the permission
// hook, and it is read once below. On a first boot agent-host may start before
// the gateway has written one, so make sure it exists first (whichever process
// starts first creates it; the gateway re-reads the file when it changes).
ensureToken();
const animaConfig = loadConfig();
const agentHostConfig = animaConfig.agentHost;
// `agentHost.port` in anima.json, or env ANIMA_AGENT_HOST_PORT (applied by loadConfig).
const PORT = agentHostConfig.port;

// anima.json wins; env vars override (handy for one-off runs); defaults last.
const IDLE_STALE_MS = parseMs(
  process.env.ANIMA_AGENT_IDLE_STALE_MS,
  agentHostConfig.idleStaleMs ?? 7_200_000,
);
const IDLE_REAP_INTERVAL_MS = parseMs(
  process.env.ANIMA_AGENT_IDLE_REAP_INTERVAL_MS,
  agentHostConfig.reapIntervalMs ?? 60_000,
);
const REAP_TMUX_ORPHANS = agentHostConfig.reapTmuxOrphans !== false;

function forceClearGatewayLocks(): void {
  if (!FORCE_STARTUP) return;

  const dbPath = join(animaDataDir(), "anima.db");
  if (!existsSync(dbPath)) {
    log.warn("Force startup requested, but gateway DB does not exist yet", { dbPath });
    return;
  }

  const db = new Database(dbPath);
  const clear = (tableName: string): number => {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName);
    if (!exists) return 0;
    const result = db.query(`DELETE FROM ${tableName}`).run();
    return result.changes;
  };

  try {
    const cleared = {
      extensionProcessLocks: clear("extension_process_locks"),
      memoryExtensionLocks: clear("memory_extension_locks"),
      memoryFileLocks: clear("memory_file_locks"),
    };
    log.warn("Force startup requested; cleared gateway lock tables", cleared);
  } catch (error) {
    log.error("Failed to clear gateway lock tables during force startup", {
      error: String(error),
    });
  } finally {
    db.close();
  }
}

forceClearGatewayLocks();

const ctx = await createAgentHostServer({ port: PORT });

/**
 * Reap orphan tmux panes: abandoned CLI panes and wrappers whose session is
 * gone or long idle. The rules, and why each is safe, are in `tmux-reaper.ts`.
 */
async function reapOrphanTmuxPanes(staleMs: number): Promise<number> {
  // A fresh snapshot, never a cached one: a live `claude` is the one thing
  // that keeps an untracked CLI pane alive, and this is about to kill panes.
  await liveness.refresh();
  const tracked = ctx.sessionHost.trackedIds ? ctx.sessionHost.trackedIds() : new Set<string>();
  const reapCtx = {
    nowSec: Date.now() / 1000,
    staleMs,
    isTracked: (id: string) => tracked.has(id),
    claudeAlive: (id: string) => liveness.claudeAlive(id),
  };
  let killed = 0;
  for (const s of listTmuxSessions()) {
    const kind = reapVerdict(s, reapCtx);
    if (!kind) continue;
    killSession(s.name);
    log.info("Reaped orphan tmux pane", {
      name: s.name,
      kind,
      idleSec: Math.floor(Date.now() / 1000 - s.activitySec),
    });
    killed++;
  }
  return killed;
}

// The only place these land in a durable artifact. Without this line, the only
// way to tell whether an `anima.json` edit actually took effect is to correlate
// the file's mtime against the process start time.
log.info("Idle reaper configured", {
  idleStaleMs: IDLE_STALE_MS,
  reapIntervalMs: IDLE_REAP_INTERVAL_MS,
  reapTmuxOrphans: REAP_TMUX_ORPHANS,
});

let idleReapRunning = false;
const idleReapTimer = setInterval(async () => {
  if (idleReapRunning) return;
  idleReapRunning = true;
  try {
    if (ctx.sessionHost.reapIdleRunningSessions) {
      const closedIds = await ctx.sessionHost.reapIdleRunningSessions(IDLE_STALE_MS);
      if (closedIds.length > 0) {
        for (const [, client] of ctx.clients) {
          for (const sessionId of closedIds) {
            client.subscribedSessions.delete(sessionId);
          }
        }
        log.info("Closed idle sessions", {
          idleMs: IDLE_STALE_MS,
          count: closedIds.length,
          sessions: closedIds.map((id) => id.slice(0, 8)),
        });
      }
    }
    if (REAP_TMUX_ORPHANS) {
      await reapOrphanTmuxPanes(IDLE_STALE_MS);
    }
  } catch (error) {
    log.warn("Idle session reaper failed", { error: String(error) });
  } finally {
    idleReapRunning = false;
  }
}, IDLE_REAP_INTERVAL_MS);

// The watchdog sets this from watchdog.json's `drainMs`. Unset (agent-host
// run by hand) means no drain.
const DRAIN_MS = drainCapFromEnv();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second signal mid-drain (an orphan sweep, a repeated restart) must not
  // cut the responses the first one is waiting for. SIGKILL is the override.
  if (shuttingDown) {
    log.info(`Received ${signal} while shutting down; still draining`);
    return;
  }
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down...`, { drainMs: DRAIN_MS });
  clearInterval(idleReapTimer);
  await ctx.stop(signal, { drainMs: DRAIN_MS });
  // The drain's outcome (which sessions the cap cut) is the line that matters most.
  await flushLogs();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Prevent unhandled SDK errors from crashing the process.
// The most common culprit is "ProcessTransport is not ready for writing" which
// fires when a zombie session's underlying claude process has died. We close the
// offending session so it can be cleanly lazy-resumed on the next prompt.
function handleUnhandledError(error: unknown, origin: string): void {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("ProcessTransport is not ready")) {
    log.warn("Caught unhandled ProcessTransport error — closing zombie sessions", {
      origin,
      error: msg,
    });
    // Close any session whose transport is dead so it can lazy-resume cleanly
    try {
      for (const info of ctx.sessionHost.list()) {
        if (!(info as Record<string, unknown>).isProcessRunning) {
          const id = (info as Record<string, unknown>).sessionId as string;
          ctx.sessionHost.close(id).catch(() => {});
          log.warn("Closed zombie session", { sessionId: id.slice(0, 8) });
        }
      }
    } catch {
      // best-effort
    }
    return;
  }
  // For all other unhandled errors, log and exit so the watchdog restarts us cleanly
  log.error(`Unhandled ${origin}`, { error: msg });
  process.exit(1);
}

process.on("uncaughtException", (error) => handleUnhandledError(error, "uncaughtException"));
process.on("unhandledRejection", (reason) => handleUnhandledError(reason, "unhandledRejection"));
