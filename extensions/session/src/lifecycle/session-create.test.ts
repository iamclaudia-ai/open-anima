import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as store from "../session-store";
import * as statusEvents from "../session-status-events";
import { initRuntime, resetRuntime, type SessionRuntime } from "../runtime";
import {
  createDraftSession,
  startTopLevelSession,
  type TopLevelSessionDeps,
} from "./session-create";

describe("createDraftSession origin", () => {
  const upserts: Array<Record<string, unknown>> = [];
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    upserts.length = 0;
    // No database: the row and its side effects are recorded, never written.
    spies = [
      spyOn(store, "setSessionProfile").mockImplementation(() => true),
      spyOn(statusEvents, "emitListChanged").mockImplementation(() => {}),
    ];
    initRuntime({
      sessionConfig: { model: "opus", thinking: false, effort: "medium" },
      registry: {
        getOrCreateWorkspace: () => ({ workspace: { id: "ws-1" } }),
        upsertSession: (params: Record<string, unknown>) => upserts.push(params),
        setWorkspaceActiveSession: () => {},
      },
    } as unknown as SessionRuntime);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    resetRuntime();
  });

  test("a caller that doesn't say is automated: only the UI clients opt in as the user", () => {
    createDraftSession({ cwd: "/repo", profile: "yolo" });
    expect(upserts[0]).toMatchObject({ origin: "automated", launchedBySessionId: null });
  });

  test("keeps the origin and launcher the caller gives", () => {
    createDraftSession({ cwd: "/repo", profile: "yolo", origin: "user" });
    createDraftSession({ cwd: "/repo", profile: "auto", launchedBySessionId: "ses-coord" });
    expect(upserts[0]).toMatchObject({ origin: "user" });
    expect(upserts[1]).toMatchObject({ origin: "automated", launchedBySessionId: "ses-coord" });
  });
});

function recordingDeps() {
  const calls: string[] = [];
  const titles: Array<[string, string]> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const profiles: string[] = [];
  const deps: TopLevelSessionDeps = {
    defaultProfile: "auto",
    createDraft: (params) => {
      calls.push(`create:${params.cwd}`);
      profiles.push(params.profile);
      return {
        sessionId: "sess-1",
        workspaceId: "ws-1",
        agent: params.agent ?? "claude",
        model: "opus",
      };
    },
    setTitle: (sessionId, title) => {
      calls.push("title");
      titles.push([sessionId, title]);
    },
    sendPrompt: async (params) => {
      calls.push("prompt");
      prompts.push(params);
    },
  };
  return { deps, calls, titles, prompts, profiles };
}

describe("startTopLevelSession", () => {
  test("uses the spawn default profile unless the caller names one", async () => {
    const { deps, profiles } = recordingDeps();
    await startTopLevelSession({ cwd: "/repo", prompt: "a" }, deps);
    await startTopLevelSession({ cwd: "/repo", prompt: "b", profile: "locked" }, deps);
    expect(profiles).toEqual(["auto", "locked"]);
  });

  test("creates, names, then prompts, in that order", async () => {
    const { deps, calls, titles, prompts } = recordingDeps();
    const result = await startTopLevelSession(
      { cwd: "/repo", prompt: "Run the weekly sweep", name: "Weekly deps" },
      deps,
    );

    expect(calls).toEqual(["create:/repo", "title", "prompt"]);
    expect(titles).toEqual([["sess-1", "Weekly deps"]]);
    expect(prompts).toEqual([
      {
        sessionId: "sess-1",
        content: "Run the weekly sweep",
        cwd: "/repo",
        model: "opus",
        agent: "claude",
      },
    ]);
    expect(result).toEqual({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      parentSessionId: null,
      agent: "claude",
      cwd: "/repo",
      title: "Weekly deps",
      status: "running",
    });
  });

  test("leaves the title to the prompt fallback when no name is given", async () => {
    const { deps, calls } = recordingDeps();
    const result = await startTopLevelSession({ cwd: "/repo", prompt: "hi", name: "   " }, deps);
    expect(calls).toEqual(["create:/repo", "prompt"]);
    expect(result.title).toBeNull();
  });

  test("passes the agent through to both create and prompt", async () => {
    const { deps, prompts } = recordingDeps();
    await startTopLevelSession({ cwd: "/repo", prompt: "review", agent: "codex" }, deps);
    expect(prompts[0]?.agent).toBe("codex");
  });

  test("requires a cwd, since there is no parent to inherit one from", async () => {
    const { deps, calls } = recordingDeps();
    await expect(startTopLevelSession({ prompt: "hi" }, deps)).rejects.toThrow(
      'cwd is required when parentSessionId is "NEW"',
    );
    expect(calls).toEqual([]);
  });
});
