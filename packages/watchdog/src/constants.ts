/**
 * Shared constants for the watchdog.
 * All magic numbers, paths, and config values live here.
 *
 * Config is loaded from ~/.anima/watchdog.json — zero monorepo imports.
 *
 * A second instance on the same machine points everything elsewhere with the
 * same env as the rest of Anima (see packages/shared/src/instance.ts):
 *  - `ANIMA_WATCHDOG_CONFIG`: watchdog.json (default `$ANIMA_HOME/.anima/watchdog.json`)
 *  - `ANIMA_CONFIG` / `ANIMA_HOME`: anima.json, for the gateway token
 *  - `ANIMA_DATA_DIR`: logs (`<data>/logs`) and the database (`<data>/anima.db`)
 *  - `ANIMA_WATCHDOG_PORT`: overrides `port` from watchdog.json (default 30085)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

// ── Config Loading ──────────────────────────────────────

export interface ServiceConfig {
  name: string;
  command: string[];
  cwd?: string;
  healthUrl?: string;
  port?: number;
  healthCheck?: {
    requireExtensions?: boolean;
  };
  /**
   * Let the service finish in-flight work after SIGTERM. It must free
   * its port promptly; once it has, the replacement starts while the old
   * process drains for up to this long (passed to it as `ANIMA_DRAIN_MS`).
   * Such a service is spawned detached, so a watchdog reload doesn't take it
   * down with the watchdog's process group. Omitted: 1s, then SIGKILL.
   */
  drainMs?: number;
}

export interface WatchdogConfig {
  port?: number;
  logsDir?: string;
  services: Record<string, ServiceConfig>;
}

/** The folder that holds `.anima/` (`$ANIMA_HOME`, default the home folder). */
const CONFIG_HOME = process.env.ANIMA_HOME || homedir();
/** Anima's data folder (`$ANIMA_DATA_DIR`, default `~/.anima`). */
const DATA_DIR = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");

const CONFIG_PATH =
  process.env.ANIMA_WATCHDOG_CONFIG || join(CONFIG_HOME, ".anima", "watchdog.json");

function loadConfig(): WatchdogConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Watchdog config not found at ${CONFIG_PATH}. Create it with service definitions.`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as WatchdogConfig;
}

export const config = loadConfig();

// ── Gateway Token ──────────────────────────────────────

const ANIMA_CONFIG_PATH = process.env.ANIMA_CONFIG || join(CONFIG_HOME, ".anima", "anima.json");

/**
 * Read the gateway bearer token from anima.json (`$ANIMA_CONFIG`, else
 * `$ANIMA_HOME/.anima/anima.json`).
 * Returns null if config doesn't exist or has no token.
 * Re-reads on each call to pick up token changes without restart.
 */
export function getGatewayToken(): string | null {
  try {
    if (!existsSync(ANIMA_CONFIG_PATH)) return null;
    const raw = readFileSync(ANIMA_CONFIG_PATH, "utf-8");
    // Simple regex extraction — avoids needing a JSON5 parser
    const match = raw.match(/"token"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Resolved Constants ──────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function envPort(name: string): number | undefined {
  const port = Number(process.env[name]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export const WATCHDOG_PORT = envPort("ANIMA_WATCHDOG_PORT") ?? config.port ?? 30085;
export const PROJECT_DIR = process.env.ANIMA_PROJECT_DIR || process.cwd();
export const LOGS_DIR = config.logsDir ? resolvePath(config.logsDir) : join(DATA_DIR, "logs");
export const LOG_FILE = join(LOGS_DIR, "watchdog.log");
export const RECOVERY_JOURNAL_FILE = join(LOGS_DIR, "watchdog-recovery.jsonl");
export const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_LOG_FILES = 2;
export const HEALTH_CHECK_INTERVAL = 5000; // 5s
export const HEALTH_HISTORY_SIZE = 60; // 5-minute window at 5s intervals
export const UNHEALTHY_RESTART_THRESHOLD = 6; // 6 consecutive failures = 30s
export const STARTED_AT = Date.now();

export function getAnimaDbPath(): string {
  return process.env.ANIMA_DB_PATH || join(DATA_DIR, "anima.db");
}
