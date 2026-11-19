import { describe, expect, test } from "bun:test";
import type { StoredSession } from "../session-store";
import { toSessionSubagentFromStored, toSubagentStatus } from "./subagent-workflow";

function row(overrides: Partial<StoredSession>): StoredSession {
  return {
    id: "sub-1",
    workspaceId: "ws_1",
    providerSessionId: "sub-1",
    model: "claude-opus",
    agent: "claude",
    purpose: "subagent",
    parentSessionId: "parent-1",
    status: "active",
    runtimeStatus: "idle",
    disposition: "open",
    title: null,
    summary: null,
    metadata: { prompt: "read the thread" },
    previousSessionId: null,
    cwd: "/tmp/x",
    origin: "automated",
    launchedBySessionId: null,
    lastActivity: "2026-11-15T18:09:37.000Z",
    createdAt: "2026-11-15T18:08:59.000Z",
    updatedAt: "2026-11-15T18:31:39.000Z",
    ...overrides,
  };
}

describe("subagent status", () => {
  test("its own metadata status wins over the shared runtime status", () => {
    // The bug this guards: finished, then a reconnect sweep marked the quiet pane stalled.
    const sub = toSessionSubagentFromStored(
      row({ runtimeStatus: "stalled", metadata: { prompt: "p", subagentStatus: "completed" } }),
    );
    expect(sub?.status).toBe("completed");
  });

  test("a running subagent stays running whatever the sweeps write", () => {
    expect(toSubagentStatus("running", "idle")).toBe("running");
  });

  test("legacy rows: only a turn in flight counts as running", () => {
    expect(toSubagentStatus(undefined, "running")).toBe("running");
    expect(toSubagentStatus(undefined, "awaiting_approval")).toBe("running");
    expect(toSubagentStatus(undefined, "stalled")).toBe("completed");
    expect(toSubagentStatus(undefined, "idle")).toBe("completed");
    expect(toSubagentStatus(undefined, "completed")).toBe("completed");
    expect(toSubagentStatus(undefined, "api_error")).toBe("failed");
    expect(toSubagentStatus(undefined, "interrupted")).toBe("interrupted");
  });

  test("garbage in metadata falls back to the runtime status", () => {
    expect(toSubagentStatus("busy", "stalled")).toBe("completed");
  });
});
