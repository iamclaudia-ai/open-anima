import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, GatewayEvent, LoggerLike } from "@anima/shared";
import { createHooksExtension } from "../extensions/hooks/src/index";
import { SESSION_STATUS_CHANGED } from "../extensions/session/src/session-status-events";
import turnSummaryHook, { summarizeTurn } from "./turn-summary";

const quietLog: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => quietLog,
};

/** Just enough ExtensionContext for the hooks extension: one `*` listener and a record of emits. */
function hostContext() {
  let listener: ((event: GatewayEvent) => void) | null = null;
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const ctx = {
    on(_pattern: string, handler: (event: GatewayEvent) => void) {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    emit(type: string, payload: unknown) {
      emitted.push({ type, payload });
    },
    log: quietLog,
  } as unknown as ExtensionContext;
  return {
    ctx,
    emitted,
    deliver(type: string, payload: unknown) {
      if (!listener) throw new Error("hooks extension isn't listening");
      listener({ type, payload, timestamp: Date.now() });
    },
  };
}

const finishedTurn = {
  sessionId: "ses-1",
  workspaceId: "ws-1",
  cwd: "/work/app",
  runtimeStatus: "completed",
  previousRuntimeStatus: "running",
  disposition: "open",
  title: "Fix the login redirect",
  firstPrompt: "the login page loops",
  at: "2026-11-19T10:00:00.000Z",
};

describe("turn-summary hook", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anima-turn-summary-"));
    await copyFile(join(import.meta.dir, "turn-summary.ts"), join(dir, "turn-summary.ts"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("listens to the event the session extension really emits", () => {
    expect(turnSummaryHook.event).toBe(SESSION_STATUS_CHANGED);
  });

  it("fires through the hooks extension when a turn completes", async () => {
    const host = hostContext();
    const extension = createHooksExtension({ extraDirs: [dir] });
    await extension.start(host.ctx);
    try {
      host.deliver(SESSION_STATUS_CHANGED, { ...finishedTurn, runtimeStatus: "running" });
      host.deliver(SESSION_STATUS_CHANGED, finishedTurn);
      // Dispatch is async (it may load workspace hooks first).
      await Bun.sleep(20);

      expect(host.emitted).toEqual([
        {
          type: "hook.turn-summary.turn_completed",
          payload: {
            sessionId: "ses-1",
            cwd: "/work/app",
            summary: "Fix the login redirect finished a turn (in /work/app)",
            at: "2026-11-19T10:00:00.000Z",
          },
        },
      ]);
    } finally {
      await extension.stop();
    }
  });

  it("ignores status changes that aren't a turn finishing", () => {
    expect(summarizeTurn({ ...finishedTurn, runtimeStatus: "running" })).toBeNull();
    // A disposition-only change carries no previous runtime status.
    expect(summarizeTurn({ ...finishedTurn, previousRuntimeStatus: undefined })).toBeNull();
    expect(summarizeTurn({ ...finishedTurn, previousRuntimeStatus: "completed" })).toBeNull();
  });

  it("names an untitled session by its first prompt", () => {
    expect(summarizeTurn({ ...finishedTurn, title: null, cwd: null })?.summary).toBe(
      "the login page loops finished a turn",
    );
  });
});
