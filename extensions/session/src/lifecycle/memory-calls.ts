import { withTimeout, type LoggerLike } from "@anima/shared";

/**
 * Calls into the memory extension, which is optional.
 *
 * With memory off (the default), the gateway answers every `memory.*` call
 * with "No extension found for method: …". That is the normal state, not a
 * failure, so it is logged once per logger at info level instead of as a
 * warning on every prompt. Real failures (a timeout, an error inside memory)
 * still warn. Either way the caller gets `null` and carries on without memory.
 */

const MEMORY_NOT_LOADED = "No extension found for method: memory.";

/** Loggers that have already said memory isn't loaded. */
const toldNotLoaded = new WeakSet<object>();

export function isMemoryNotLoaded(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(MEMORY_NOT_LOADED);
}

export async function callMemory(params: {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  method: `memory.${string}`;
  params: Record<string, unknown>;
  timeoutMs: number;
  log: Pick<LoggerLike, "info" | "warn">;
  /** The warning to log when memory is loaded but the call fails. */
  failure: string;
  meta?: Record<string, unknown>;
}): Promise<unknown> {
  try {
    return await withTimeout(
      params.call(params.method, params.params),
      params.timeoutMs,
      params.method,
    );
  } catch (err) {
    if (isMemoryNotLoaded(err)) {
      if (!toldNotLoaded.has(params.log)) {
        toldNotLoaded.add(params.log);
        params.log.info("Memory extension not loaded: sessions start without memory context");
      }
    } else {
      params.log.warn(params.failure, { ...params.meta, error: String(err) });
    }
    return null;
  }
}
