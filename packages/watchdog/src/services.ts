/**
 * Service management — direct process supervision, health checks, auto-restart.
 *
 * Service definitions are loaded from watchdog.json (see constants.ts) — no hardcoded commands.
 * Manages services as direct child processes (Bun.spawn).
 * No tmux — stdout/stderr pipe to log files, watchdog owns the process lifecycle.
 */

import {
  config,
  PROJECT_DIR,
  LOGS_DIR,
  HEALTH_HISTORY_SIZE,
  UNHEALTHY_RESTART_THRESHOLD,
  getGatewayToken,
} from "./constants";
import type { ServiceConfig } from "./constants";
import { log } from "./logger";
import { recordRecoveryEvent } from "./recovery-journal";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Subprocess } from "bun";

/**
 * Capture the full login shell environment by running `zsh -l -c env`.
 *
 * Compiled Bun binaries launched via launchd don't inherit the user's login
 * shell environment — even with the `zsh -l` wrapper in the plist, the binary
 * sees a minimal process.env. This function spawns a real login shell, runs
 * `env`, and parses the output so we can inject every variable (API keys,
 * PATH additions, etc.) into all child processes.
 *
 * Falls back to process.env on any error so startup never blocks.
 */
async function captureLoginShellEnv(): Promise<Record<string, string>> {
  try {
    // -i (interactive) + -l (login) ensures both .zprofile AND .zshrc are
    // sourced, so API keys exported from your shell profile get loaded.
    const proc = Bun.spawn(["/bin/zsh", "-i", "-l", "-c", "env"], {
      detached: true,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const env: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return Object.keys(env).length > 10 ? env : { ...(process.env as Record<string, string>) };
  } catch {
    return { ...(process.env as Record<string, string>) };
  }
}

/**
 * The login shell's environment with the watchdog's own `ANIMA_*` variables on
 * top. Those say which instance this is (its folders, ports, tmux prefix), so
 * a dotfile that exports, say, `ANIMA_DATA_DIR` for another instance must not
 * point this watchdog's services at it. Returns the merged env and the names
 * of the login-shell values that were overridden.
 */
export function withOwnAnimaEnv(
  loginEnv: Record<string, string>,
  ownEnv: Record<string, string | undefined>,
): { env: Record<string, string>; overridden: string[] } {
  const env = { ...loginEnv };
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(ownEnv)) {
    if (!key.startsWith("ANIMA_") || value === undefined) continue;
    if (key in loginEnv && loginEnv[key] !== value) overridden.push(key);
    env[key] = value;
  }
  return { env, overridden };
}

// Captured once at startup — all services inherit this full environment.
const loginEnv = withOwnAnimaEnv(await captureLoginShellEnv(), process.env);
export const LOGIN_ENV: Record<string, string> = loginEnv.env;
log(
  "INFO",
  `Login shell env captured: ${Object.keys(LOGIN_ENV).length} variables, PATH entries=${LOGIN_ENV.PATH?.split(":").length ?? 0}`,
);
if (loginEnv.overridden.length > 0) {
  log(
    "INFO",
    `Kept the watchdog's own value over the login shell's for: ${loginEnv.overridden.join(", ")}`,
  );
}

/**
 * Resolve the absolute path to the bun executable.
 *
 * We can't use process.execPath because the watchdog is a compiled Bun binary —
 * process.execPath returns the watchdog binary itself, not the bun runtime.
 * Instead, probe well-known install locations then fall back to PATH lookup.
 */
function findBunBin(): string {
  const home = homedir();
  const candidates = [
    join(home, ".bun", "bin", "bun"), // Standard bun install
    "/opt/homebrew/bin/bun", // Homebrew
    "/usr/local/bin/bun", // Manual install
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = Bun.which("bun");
  if (which) return which;
  throw new Error("Cannot find bun executable — checked ~/.bun/bin, homebrew, and PATH");
}

const BUN_BIN = findBunBin();

// ── Types ────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: number;
  processAlive: boolean;
  healthy: boolean;
  reason?: string;
}

export interface ManagedService {
  name: string;
  id: string;
  command: string[];
  cwd: string;
  healthUrl: string | null;
  port: number | null;
  requireExtensions: boolean;
  /** See `ServiceConfig.drainMs`. 0 = no drain. */
  drainMs: number;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
  proc: Subprocess | null;
  lastHealthReason?: string | null;
  lastHealthDetails?: Record<string, unknown> | null;
  activeIncident?: {
    key: string;
    incidentId: string;
    reason: string | null;
    openedAt: number;
    firstEvidence?: Record<string, unknown> | null;
    restartRequestedAt?: number | null;
    restartCompletedAt?: number | null;
    restartAttemptId?: string | null;
  } | null;
}

// ── Build Services from Config ──────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function buildService(id: string, cfg: ServiceConfig): ManagedService {
  return {
    name: cfg.name,
    id,
    command: cfg.command,
    cwd: cfg.cwd ? resolvePath(cfg.cwd) : PROJECT_DIR,
    healthUrl: cfg.healthUrl ?? null,
    port: cfg.port ?? null,
    requireExtensions: cfg.healthCheck?.requireExtensions ?? false,
    drainMs: cfg.drainMs && cfg.drainMs > 0 ? cfg.drainMs : 0,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
    lastHealthDetails: null,
    activeIncident: null,
  };
}

export const services: Record<string, ManagedService> = {};
for (const [id, cfg] of Object.entries(config.services)) {
  services[id] = buildService(id, cfg);
}

// ── Process Helpers ─────────────────────────────────────

export function isProcessAlive(service: ManagedService): boolean {
  if (!service.proc) return false;
  // Bun subprocess: exitCode is null while running
  return service.proc.exitCode === null;
}

/**
 * PIDs *listening* on a TCP port. Only listeners: a bare `tcp:PORT` match also
 * returns every client connected to it (the session extension, a draining
 * agent-host's last sockets), which are not what holds the port.
 */
async function listeningPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n !== process.pid);
}

/** A process's working directory (`lsof -d cwd`), or null when it can't be read. */
async function processCwd(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const line = output.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

/**
 * Whether a process holding a service's port is one of ours: started in the
 * service's folder (or below it). Anything else, such as another Anima
 * instance on the same machine whose watchdog.json names the same port, is
 * left alone, and the start fails loudly on the busy port instead.
 */
export function ownedByService(cwd: string | null, serviceCwd: string): boolean {
  if (!cwd) return false;
  const root = serviceCwd.replace(/\/+$/, "");
  return cwd === root || cwd.startsWith(`${root}/`);
}

async function killOrphanProcesses(port: number, serviceCwd: string): Promise<void> {
  const pids: number[] = [];
  for (const pid of await listeningPids(port)) {
    const cwd = await processCwd(pid);
    if (ownedByService(cwd, serviceCwd)) {
      pids.push(pid);
    } else {
      log(
        "ERROR",
        `Port ${port} is held by PID ${pid} (cwd ${cwd ?? "unknown"}), which is not from ` +
          `${serviceCwd}; leaving it alone. Give this instance its own ports.`,
      );
    }
  }
  if (pids.length === 0) return;

  for (const pid of pids) {
    log("WARN", `Killing orphan process on port ${port}: PID ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(1000);
  // A draining service ignores a repeated SIGTERM, and a hung one can't act on
  // it. Either way, one still holding the port now has to go.
  for (const pid of (await listeningPids(port)).filter((p) => pids.includes(p))) {
    log("WARN", `Orphan on port ${port} survived SIGTERM, killing: PID ${pid}`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a draining service gets to free its port after SIGTERM. */
const PORT_RELEASE_TIMEOUT_MS = 10_000;
/** Slack past `drainMs` before the watchdog kills a draining process itself. */
const DRAIN_BACKSTOP_SLACK_MS = 30_000;

/**
 * Stop a running service so it can be replaced.
 *
 * A `drainMs` service (agent-host) frees its ports at once on SIGTERM and then
 * finishes in-flight responses. We wait only for the port: once it's
 * free the replacement can start, and the old process exits on its own when
 * its responses end. A backstop kills it if it outlives its cap. If it still
 * holds the port after 10s it's hung, and SIGKILL it is.
 *
 * Everything else gets the old treatment: 1s, then SIGKILL.
 */
async function stopForReplacement(service: ManagedService): Promise<void> {
  const proc = service.proc;
  if (!proc || proc.exitCode !== null) return;
  log("INFO", `Stopping ${service.name} (PID ${proc.pid})...`);
  proc.kill("SIGTERM");

  if (service.drainMs > 0 && service.port) {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return;
      if (!(await listeningPids(service.port)).includes(proc.pid)) {
        log(
          "INFO",
          `${service.name} (PID ${proc.pid}) released port ${service.port}; ` +
            `it drains in-flight work for up to ${Math.round(service.drainMs / 1000)}s`,
        );
        const backstop = setTimeout(() => {
          if (proc.exitCode !== null) return;
          log("WARN", `${service.name} (PID ${proc.pid}) outlived its drain cap, killing`);
          proc.kill("SIGKILL");
        }, service.drainMs + DRAIN_BACKSTOP_SLACK_MS);
        void proc.exited.then(() => clearTimeout(backstop));
        return;
      }
      await sleep(100);
    }
    log("WARN", `${service.name} (PID ${proc.pid}) still holds port ${service.port}, killing`);
    proc.kill("SIGKILL");
    await sleep(500);
    return;
  }

  // Give it a moment to die, then force it.
  await sleep(1000);
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await sleep(500);
  }
}

async function drainToLog(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  logPath: string,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendFileSync(logPath, decoder.decode(value, { stream: true }));
    }
  } catch {
    // Stream closed on process exit
  }
}

export interface StartServiceOptions {
  force?: boolean;
}

/**
 * Resolve the executable in a command to its absolute path.
 *
 * "bun" always resolves to process.execPath (the binary running the watchdog).
 * Other executables are resolved via Bun.which() first, then by probing
 * common user install dirs (~/.local/bin, ~/.bun/bin, /opt/homebrew/bin, etc.).
 * This ensures services can be spawned correctly even when launchd provides a
 * minimal PATH that omits user install dirs.
 */
function resolveCommand(cmd: string[]): string[] {
  if (cmd.length === 0) return cmd;
  const [exe, ...rest] = cmd;
  // Already absolute
  if (exe.startsWith("/")) return cmd;
  // bun → always use the binary running this process
  if (exe === "bun") return [BUN_BIN, ...rest];
  // Try Bun.which (works when PATH is populated)
  const which = Bun.which(exe);
  if (which) return [which, ...rest];
  // Probe common user install dirs as fallback (compiled binaries may lack user PATH)
  const home = homedir();
  const searchDirs = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `/opt/homebrew/bin`,
    `/usr/local/bin`,
  ];
  for (const dir of searchDirs) {
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return [candidate, ...rest];
  }
  log("WARN", `Could not resolve executable "${exe}" in PATH or common dirs`);
  return cmd;
}

function commandForStart(service: ManagedService, force = false): string[] {
  const cmd =
    force && !service.command.includes("--force")
      ? [...service.command, "--force"]
      : service.command;
  return resolveCommand(cmd);
}

export async function startService(
  service: ManagedService,
  options: StartServiceOptions = {},
): Promise<void> {
  const force = options.force === true;

  await stopForReplacement(service);

  // Kill any orphan processes already bound to this port
  if (service.port) {
    await killOrphanProcesses(service.port, service.cwd);
  }

  // Ensure log dir exists
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = join(LOGS_DIR, `${service.id}.log`);
  const command = commandForStart(service, force);

  // Spawn as direct child process. Use pipes + explicit drains to avoid
  // Bun.file stdio redirection issues that can cause runaway CPU.
  const drains = service.drainMs > 0;
  service.proc = Bun.spawn(command, {
    cwd: service.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...LOGIN_ENV,
      FORCE_COLOR: "0",
      ...(drains ? { ANIMA_DRAIN_MS: String(service.drainMs) } : {}),
    },
    // Its own process group: a watchdog reload (launchd reaps the watchdog's
    // group) must not kill it mid-drain. It outlives a dead stdout reader.
    detached: drains,
  });

  // Drain child output into the service log asynchronously.
  drainToLog(service.proc.stdout, logPath);
  drainToLog(service.proc.stderr, logPath);

  service.lastRestart = Date.now();
  service.consecutiveFailures = 0;
  service.lastHealthReason = null;
  log("INFO", `Started ${service.name} (PID ${service.proc.pid})${force ? " [force]" : ""}`);

  // Monitor for unexpected exit (or a replaced process finishing its drain)
  const pid = service.proc.pid;
  service.proc.exited.then((code) => {
    log("WARN", `${service.name} (PID ${pid}) exited with code ${code}`);
  });
}

export interface RestartServiceOptions {
  force?: boolean;
}

function normalizeServiceId(id: string): string {
  if (id === "runtime") return "agent-host";
  return id;
}

export async function restartService(
  id: string,
  options: RestartServiceOptions = {},
): Promise<{ ok: boolean; message: string }> {
  const serviceId = normalizeServiceId(id);
  const service = services[serviceId];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }
  const force = options.force === true;

  log("INFO", `Restarting ${service.name}${force ? " [force]" : ""}...`);
  await startService(service, { force });
  return { ok: true, message: `${service.name} restarted (PID ${service.proc?.pid})` };
}

export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export async function checkHealth(service: ManagedService): Promise<HealthCheckResult> {
  // No healthUrl — process-alive is the only check
  if (!service.healthUrl) {
    return isProcessAlive(service) ? { healthy: true } : { healthy: false, reason: "dead" };
  }

  try {
    const headers: Record<string, string> = {};
    const token = getGatewayToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2000), headers });
    if (!res.ok) {
      return { healthy: false, reason: `http_${res.status}` };
    }

    // If this service requires extensions to be loaded, check for that
    if (service.requireExtensions) {
      const body = (await res.json()) as { extensions?: Record<string, unknown> };
      const extensionCount = body.extensions ? Object.keys(body.extensions).length : 0;
      if (extensionCount === 0) {
        return { healthy: false, reason: "zero_extensions", details: { extensionCount } };
      }
    }

    return { healthy: true };
  } catch {
    return { healthy: false, reason: "unreachable" };
  }
}

function restartThresholdForReason(reason: string | null): number {
  return UNHEALTHY_RESTART_THRESHOLD;
}

function incidentKeyFor(service: ManagedService, reason: string | null): string {
  return `${service.id}:${reason ?? "unknown"}`;
}

function buildDurations(
  service: ManagedService,
  now = Date.now(),
): {
  incidentMs?: number;
  restartRequestedMs?: number;
  restartCompletedMs?: number;
  recoveryMs?: number;
} {
  const incident = service.activeIncident;
  if (!incident) return {};
  return {
    incidentMs: now - incident.openedAt,
    restartRequestedMs: incident.restartRequestedAt ? now - incident.restartRequestedAt : undefined,
    restartCompletedMs: incident.restartCompletedAt ? now - incident.restartCompletedAt : undefined,
    recoveryMs: incident.restartCompletedAt ? now - incident.restartCompletedAt : undefined,
  };
}

function openIncident(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown> | undefined,
): void {
  const key = incidentKeyFor(service, reason);
  if (service.activeIncident?.key === key) {
    return;
  }

  service.activeIncident = {
    key,
    incidentId: crypto.randomUUID(),
    reason,
    openedAt: Date.now(),
    firstEvidence: details ?? null,
    restartRequestedAt: null,
    restartCompletedAt: null,
    restartAttemptId: null,
  };

  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident.incidentId,
    attemptId: null,
    event: "health_check_failed",
    reason,
    decision: {
      action: "observe",
      target: service.id,
      triggerThreshold: restartThresholdForReason(reason),
    },
    outcome: "observed",
    durations: buildDurations(service),
    evidence: {
      before: details,
    },
    details,
  });
}

function markRestartRequested(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown>,
): void {
  if (service.activeIncident?.restartRequestedAt) {
    return;
  }
  if (service.activeIncident) {
    service.activeIncident.restartRequestedAt = Date.now();
    service.activeIncident.restartAttemptId = crypto.randomUUID();
  }
  const restartThreshold = restartThresholdForReason(reason);
  const recoveryTarget =
    typeof details.recoveryTarget === "string" ? (details.recoveryTarget as string) : service.id;
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident?.incidentId,
    attemptId: service.activeIncident?.restartAttemptId ?? null,
    event: "restart_requested",
    reason,
    decision: {
      action: recoveryTarget === service.id ? "restart_service" : "restart_extension",
      target: recoveryTarget,
      triggerThreshold: restartThreshold,
    },
    outcome: "restart_in_progress",
    durations: buildDurations(service),
    evidence: {
      before:
        details.health && typeof details.health === "object"
          ? (details.health as Record<string, unknown>)
          : undefined,
    },
    details,
  });
}

function markRestartCompleted(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown>,
): void {
  if (service.activeIncident) {
    service.activeIncident.restartCompletedAt = Date.now();
  }
  const recoveryTarget =
    typeof details.recoveryTarget === "string" ? (details.recoveryTarget as string) : service.id;
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident?.incidentId,
    attemptId: service.activeIncident?.restartAttemptId ?? null,
    event: "restart_completed",
    reason,
    decision: {
      action: recoveryTarget === service.id ? "restart_service" : "restart_extension",
      target: recoveryTarget,
      triggerThreshold: restartThresholdForReason(reason),
    },
    outcome: "restart_in_progress",
    durations: buildDurations(service),
    evidence: {
      before: service.activeIncident?.firstEvidence ?? undefined,
      after: details,
    },
    details,
  });
}

function closeIncident(
  service: ManagedService,
  details: Record<string, unknown> | undefined,
): void {
  if (!service.activeIncident) return;
  const outcome = service.activeIncident.restartRequestedAt
    ? "recovered_after_restart"
    : "recovered";
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident.incidentId,
    attemptId: service.activeIncident.restartAttemptId ?? null,
    event: "health_restored",
    reason: service.activeIncident.reason,
    decision: {
      action: "wait_for_health_restore",
      target: service.id,
      triggerThreshold: restartThresholdForReason(service.activeIncident.reason),
    },
    outcome,
    durations: buildDurations(service),
    evidence: {
      before: service.activeIncident.firstEvidence ?? undefined,
      after: details,
    },
    details,
  });
  service.activeIncident = null;
}

// ── Health Monitor Loop ─────────────────────────────────

export async function monitorServices(): Promise<void> {
  for (const [_id, service] of Object.entries(services)) {
    const previousReason = service.lastHealthReason ?? null;
    const processAlive = isProcessAlive(service);
    const health = processAlive ? await checkHealth(service) : { healthy: false, reason: "dead" };
    const healthy = health.healthy;
    const reason = health.reason ?? null;
    service.lastHealthReason = reason;
    service.lastHealthDetails = health.details ?? null;

    // Record snapshot
    service.history.push({
      timestamp: Date.now(),
      processAlive,
      healthy,
      reason: reason ?? undefined,
    });
    if (service.history.length > HEALTH_HISTORY_SIZE) {
      service.history = service.history.slice(-HEALTH_HISTORY_SIZE);
    }

    if (!processAlive) {
      // Process died — restart with backoff
      service.consecutiveFailures++;
      const timeSinceRestart = Date.now() - service.lastRestart;
      if (timeSinceRestart < service.restartBackoff) continue;

      openIncident(service, "dead", undefined);
      log("WARN", `${service.name} process dead — restarting...`);
      await startService(service);
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else if (!healthy) {
      // Process alive but health check failing
      service.consecutiveFailures++;
      const restartThreshold = restartThresholdForReason(reason);
      openIncident(service, reason, health.details);
      if (service.consecutiveFailures >= restartThreshold) {
        const timeSinceRestart = Date.now() - service.lastRestart;
        if (timeSinceRestart < service.restartBackoff) continue;

        const recoveryTarget = service.id;
        markRestartRequested(service, reason, {
          consecutiveFailures: service.consecutiveFailures,
          restartBackoff: service.restartBackoff,
          recoveryTarget,
          health: health.details ?? undefined,
        });
        log(
          "WARN",
          `${service.name} unhealthy for ${service.consecutiveFailures} checks (${reason ?? "unknown"}) — restarting...`,
        );
        const useForce = reason === "zero_extensions";
        await startService(service, { force: useForce });
        markRestartCompleted(service, reason, {
          pid: service.proc?.pid ?? null,
          forced: useForce,
          recoveryTarget,
        });
        service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
      }
    } else {
      // Healthy — reset counters
      if (service.consecutiveFailures > 0 || previousReason || service.activeIncident) {
        closeIncident(service, health.details ?? undefined);
      }
      service.consecutiveFailures = 0;
      if (Date.now() - service.lastRestart > 60000) {
        service.restartBackoff = 1000;
      }
    }
  }
}

// ── Graceful Shutdown ───────────────────────────────────

export function stopAllServices(): void {
  for (const [, service] of Object.entries(services)) {
    if (service.proc && service.proc.exitCode === null) {
      log("INFO", `Stopping ${service.name} (PID ${service.proc.pid})...`);
      service.proc.kill("SIGTERM");
    }
  }
}
