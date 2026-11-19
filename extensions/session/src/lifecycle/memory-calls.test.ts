import { describe, expect, test } from "bun:test";
import { callMemory, isMemoryNotLoaded } from "./memory-calls";

function recordingLog() {
  const lines: Array<{ level: "info" | "warn"; msg: string; meta?: unknown }> = [];
  return {
    lines,
    info: (msg: string, meta?: unknown) => lines.push({ level: "info", msg, meta }),
    warn: (msg: string, meta?: unknown) => lines.push({ level: "warn", msg, meta }),
  };
}

const notLoaded = async (method: string) => {
  // What the gateway hub answers when no extension serves the method.
  throw new Error(`No extension found for method: ${method}`);
};

describe("callMemory", () => {
  test("returns the result when memory answers", async () => {
    const log = recordingLog();
    const result = await callMemory({
      call: async () => ({ recentMessages: [] }),
      method: "memory.get_session_context",
      params: {},
      timeoutMs: 1000,
      log,
      failure: "Failed to inject memory context (non-fatal)",
    });
    expect(result).toEqual({ recentMessages: [] });
    expect(log.lines).toEqual([]);
  });

  test("memory not loaded: null, one info line, never a warning", async () => {
    const log = recordingLog();
    for (const method of [
      "memory.transition_conversation",
      "memory.get_session_context",
    ] as const) {
      for (let i = 0; i < 2; i++) {
        const result = await callMemory({
          call: notLoaded,
          method,
          params: {},
          timeoutMs: 1000,
          log,
          failure: "Failed (non-fatal)",
        });
        expect(result).toBeNull();
      }
    }
    expect(log.lines).toEqual([
      {
        level: "info",
        msg: "Memory extension not loaded: sessions start without memory context",
        meta: undefined,
      },
    ]);
  });

  test("a real failure inside memory still warns, with the caller's context", async () => {
    const log = recordingLog();
    const result = await callMemory({
      call: async () => {
        throw new Error("database is locked");
      },
      method: "memory.transition_conversation",
      params: { cwd: "/x" },
      timeoutMs: 1000,
      log,
      failure: "Failed to transition previous conversations (non-fatal)",
      meta: { cwd: "/x" },
    });
    expect(result).toBeNull();
    expect(log.lines).toEqual([
      {
        level: "warn",
        msg: "Failed to transition previous conversations (non-fatal)",
        meta: { cwd: "/x", error: "Error: database is locked" },
      },
    ]);
  });

  test("a timeout warns", async () => {
    const log = recordingLog();
    const result = await callMemory({
      call: () => new Promise(() => {}),
      method: "memory.get_session_context",
      params: {},
      timeoutMs: 10,
      log,
      failure: "Failed to inject memory context (non-fatal)",
    });
    expect(result).toBeNull();
    expect(log.lines.map((line) => line.level)).toEqual(["warn"]);
  });
});

describe("isMemoryNotLoaded", () => {
  test("matches only a missing memory extension", () => {
    expect(
      isMemoryNotLoaded(new Error("No extension found for method: memory.get_session_context")),
    ).toBe(true);
    expect(isMemoryNotLoaded("No extension found for method: memory.transition_conversation")).toBe(
      true,
    );
    expect(isMemoryNotLoaded(new Error("No extension found for method: notify.send"))).toBe(false);
    expect(isMemoryNotLoaded(new Error("memory.get_session_context timed out"))).toBe(false);
  });
});
