import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as store from "../session-store";
import * as workspaceDb from "../workspace-db";
import * as gitStatus from "../git-status";
import * as statusEvents from "../session-status-events";
import { initRuntime, resetRuntime, type SessionRuntime } from "../runtime";
import { emitGitStatus, wireSessionEvents } from "./session-events";

const ROOT = "/repo/emit-git-status";
const WORKTREE = "/repo/emit-git-status.worktrees/feat/chip";

function stored(cwd: string | null): store.StoredSession {
  return {
    id: "ses_emit_git_status",
    workspaceId: "ws_emit_git_status",
    providerSessionId: "ses_emit_git_status",
    model: "test",
    agent: "claude",
    purpose: "chat",
    parentSessionId: null,
    status: "active",
    runtimeStatus: "idle",
    disposition: "open",
    title: null,
    summary: null,
    metadata: null,
    previousSessionId: null,
    cwd,
    origin: "user",
    launchedBySessionId: null,
    lastActivity: "2026-11-02",
    createdAt: "2026-11-02",
    updatedAt: "2026-11-02",
  };
}

describe("emitGitStatus", () => {
  const emit = mock(() => {});
  let spies: Array<{ mockRestore: () => void }> = [];
  let collect: ReturnType<typeof spyOn<typeof gitStatus, "collectGitStatus">>;

  beforeEach(() => {
    emit.mockClear();
    collect = spyOn(gitStatus, "collectGitStatus").mockImplementation(async (cwd) => ({
      cwd,
      branch: "feat/chip",
      detached: false,
      operation: null,
      ahead: 0,
      behind: 0,
      dirty: {
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
        renamed: 0,
        conflicted: 0,
        total: 0,
      },
      pr: null,
    }));
    spies = [
      collect,
      spyOn(workspaceDb, "getWorkspace").mockReturnValue({
        id: "ws_emit_git_status",
        cwd: ROOT,
      } as workspaceDb.Workspace),
      spyOn(store, "updateSessionMetadata").mockImplementation(() => true),
    ];
    initRuntime({
      sessionActors: { getRoutingOptions: () => undefined },
      ctx: { emit },
    } as unknown as SessionRuntime);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    resetRuntime();
  });

  it("collects git status in the session's own folder, not the workspace root", async () => {
    spies.push(spyOn(store, "getStoredSession").mockReturnValue(stored(WORKTREE)));
    await emitGitStatus("ses_emit_git_status");
    expect(collect).toHaveBeenCalledWith(WORKTREE);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the workspace root for a row with no cwd", async () => {
    spies.push(spyOn(store, "getStoredSession").mockReturnValue(stored(null)));
    await emitGitStatus("ses_emit_git_status");
    expect(collect).toHaveBeenCalledWith(ROOT);
  });
});

describe("wireSessionEvents: API-error give-up", () => {
  type Listener = (event: Record<string, unknown>) => void;
  let listener: Listener | null = null;
  let spies: Array<{ mockRestore: () => void }> = [];
  let applied: Array<[string, string]> = [];

  beforeEach(() => {
    applied = [];
    spies = [
      spyOn(statusEvents, "applyRuntimeStatus").mockImplementation((id, status) => {
        applied.push([id, status]);
        return true;
      }),
      spyOn(statusEvents, "emitActivity").mockImplementation(() => {}),
      spyOn(statusEvents, "forgetActivity").mockImplementation(() => {}),
      spyOn(store, "touchSession").mockImplementation(() => null),
      spyOn(store, "getStoredSession").mockReturnValue(null),
    ];
    initRuntime({
      sessionActors: {
        getRoutingOptions: () => undefined,
        completeTurn: () => {},
        failTurn: () => {},
        appendResponseText: () => {},
      },
      ctx: { emit: () => {} },
      bridge: {
        onSessionEvent: (fn: Listener) => {
          listener = fn;
        },
        offSessionEvent: () => {},
      },
    } as unknown as SessionRuntime);
    wireSessionEvents();
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    resetRuntime();
    listener = null;
  });

  function send(type: string, extra: Record<string, unknown> = {}): void {
    listener?.({ eventName: `session.ses_api.${type}`, sessionId: "ses_api", type, ...extra });
  }

  it("a give-up after the turn's own end is the status that sticks", () => {
    send("turn_stop", { stop_reason: "api_error" });
    send("process_ended");
    send("api_error", { status: 0, message: "API Error: Connection lost…", stalled: true });
    expect(applied.map(([, status]) => status)).toEqual(["completed", "idle", "api_error"]);
    expect(applied.at(-1)).toEqual(["ses_api", "api_error"]);
  });

  it("an API error that will be nudged doesn't change the status", () => {
    send("api_error", { status: 0, message: "…nudge 1 of 3", nudge: { attempt: 1 } });
    expect(applied).toEqual([]);
  });
});
