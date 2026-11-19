/**
 * Shutdown drain: wait for the responses still streaming through
 * released sessions, up to a cap, so a restart doesn't cut them.
 *
 * By the time this runs the listeners are closed and the new agent-host can
 * already be serving the same ports. Only the open responses keep this
 * process alive.
 */

import type { SessionDrain } from "./session-host";

export interface DrainOutcome {
  /** Sessions whose responses all finished inside the cap. */
  drained: string[];
  /** Sessions still streaming when the cap ran out: exiting cuts them. */
  cut: string[];
  elapsedMs: number;
}

interface DrainLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
}

/** Read the cap from `ANIMA_DRAIN_MS` (set by the watchdog from `drainMs`). 0 = don't wait. */
export function drainCapFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANIMA_DRAIN_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function awaitDrains(
  drains: SessionDrain[],
  capMs: number,
  log: DrainLogger,
): Promise<DrainOutcome> {
  const started = Date.now();
  const short = (id: string) => id.slice(0, 8);
  if (drains.length === 0) return { drained: [], cut: [], elapsedMs: 0 };

  log.info("Draining in-flight responses before exit", {
    sessions: drains.map((d) => ({ id: short(d.sessionId), inFlight: d.inFlight })),
    capMs,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<"cap">((resolve) => {
    timer = setTimeout(() => resolve("cap"), capMs);
  });
  const finished = new Set<string>();
  await Promise.race([
    Promise.all(drains.map((d) => d.done.then(() => finished.add(d.sessionId)))),
    capped,
  ]);
  clearTimeout(timer);

  const drained = drains.filter((d) => finished.has(d.sessionId)).map((d) => d.sessionId);
  const cut = drains.filter((d) => !finished.has(d.sessionId)).map((d) => d.sessionId);
  const elapsedMs = Date.now() - started;
  if (cut.length > 0) {
    log.warn("Drain cap reached: exiting cuts these responses", {
      cut: cut.map(short),
      drained: drained.map(short),
      elapsedMs,
    });
  } else {
    log.info("All in-flight responses finished", { sessions: drained.map(short), elapsedMs });
  }
  return { drained, cut, elapsedMs };
}
