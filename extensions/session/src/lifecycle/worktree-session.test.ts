import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorktreeSetupPending,
  pendingPromptOf,
  resumeInterruptedSetups,
  startWorktreeSession,
  waitForWorktree,
  WORKTREE_SETUP_KEY,
  worktreeSetupOf,
  type WorktreeSessionDeps,
} from "./worktree-session";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "anima-worktree-session-test-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;

/** In-memory deps; `finish` / `fail` settle the bootstrap when the test says so. */
function fakeDeps(options: { printedPath?: (expected: string) => string } = {}) {
  const metadata = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const deps: WorktreeSessionDeps = {
    repoFor: () => "/repo",
    claimFolder: (repo, path) => calls.push(`claim:${repo}:${path}`),
    createDraft: (cwd, meta) => {
      const sessionId = `sess-${++counter}`;
      calls.push(`draft:${cwd}`);
      metadata.set(sessionId, { ...meta });
      return { sessionId, workspaceId: "ws-1" };
    },
    setTitle: (_id, title) => calls.push(`title:${title}`),
    createWorktree: (request) =>
      new Promise((resolve, reject) => {
        const expected = `/repo.worktrees/${request.branch}`;
        finish = () => resolve({ path: options.printedPath?.(expected) ?? expected });
        fail = reject;
      }),
    patchMetadata: (id, patch) => {
      const next = { ...metadata.get(id) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      metadata.set(id, next);
    },
    getMetadata: (id) => metadata.get(id),
    moveSession: (id, from, to) => calls.push(`move:${id}:${from}->${to}`),
    announce: (id) => calls.push(`announce:${id}`),
  };
  return { deps, metadata, calls, finish: () => finish(), fail: (e: Error) => fail(e) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startWorktreeSession", () => {
  test("answers before the worktree exists, in the folder it will occupy", () => {
    const { deps, metadata, calls } = fakeDeps();
    const result = startWorktreeSession(
      { folder: "/repo", branch: "fix-login", profile: "yolo", title: "  Fix login  " },
      deps,
    );

    expect(result.cwd).toBe("/repo.worktrees/fix-login");
    expect(result.title).toBe("Fix login");
    expect(calls).toEqual([
      "claim:/repo:/repo.worktrees/fix-login",
      "draft:/repo.worktrees/fix-login",
      "title:Fix login",
    ]);
    expect(worktreeSetupOf(metadata.get(result.sessionId))).toMatchObject({
      state: "running",
      branch: "fix-login",
    });
    expect(isWorktreeSetupPending(result.sessionId)).toBe(true);
  });

  test("clears the marker and tells the tabs once the worktree is ready", async () => {
    const { deps, metadata, calls, finish } = fakeDeps();
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "ready", profile: "yolo" },
      deps,
    );
    finish();
    await settle();

    expect(metadata.get(sessionId)?.[WORKTREE_SETUP_KEY]).toBeUndefined();
    expect(calls.at(-1)).toBe(`announce:${sessionId}`);
    expect(isWorktreeSetupPending(sessionId)).toBe(false);
  });

  test("follows a project bootstrap that put the worktree elsewhere", async () => {
    const { deps, calls, finish } = fakeDeps({ printedPath: () => "/elsewhere/wt" });
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "moved", profile: "yolo" },
      deps,
    );
    finish();
    await settle();

    expect(calls).toContain(`move:${sessionId}:/repo.worktrees/moved->/elsewhere/wt`);
  });

  test("records the failure on the session", async () => {
    const { deps, metadata, fail } = fakeDeps();
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "broken", profile: "yolo" },
      deps,
    );
    fail(new Error("create_worktree failed (exit 1): fatal: bad ref"));
    await settle();

    expect(worktreeSetupOf(metadata.get(sessionId))).toMatchObject({
      state: "failed",
      branch: "broken",
      error: "create_worktree failed (exit 1): fatal: bad ref",
    });
  });

  test("rejects a bad branch before creating anything", () => {
    const { deps, calls } = fakeDeps();
    expect(() =>
      startWorktreeSession({ folder: "/repo", branch: "../escape", profile: "yolo" }, deps),
    ).toThrow("Not a usable worktree branch name");
    expect(calls).toEqual([]);
  });
});

describe("waitForWorktree", () => {
  test("holds a prompt until the setup finishes", async () => {
    const { deps, finish } = fakeDeps();
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "wait", profile: "yolo" },
      deps,
    );
    let released = false;
    const waiting = waitForWorktree(sessionId, deps.getMetadata).then(() => {
      released = true;
    });
    await settle();
    expect(released).toBe(false);

    finish();
    await waiting;
    expect(released).toBe(true);
  });

  test("fails the prompt when the setup failed", async () => {
    const { deps, fail } = fakeDeps();
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "nope", profile: "yolo" },
      deps,
    );
    const waiting = waitForWorktree(sessionId, deps.getMetadata);
    fail(new Error("disk full"));
    await expect(waiting).rejects.toThrow("The worktree for nope couldn't be set up: disk full");
  });

  test("passes straight through for an ordinary session", async () => {
    await waitForWorktree("plain", () => ({ bootstrapEffort: "high" }));
  });
});

describe("a prompt waiting on the worktree", () => {
  const prompt = { content: "Land the stack", agent: "claude", queuedAt: "2026-11-13T20:51:05Z" };

  test("is kept on the row while it waits, and taken off when it goes", async () => {
    const { deps, metadata, finish } = fakeDeps();
    const { sessionId } = startWorktreeSession(
      { folder: "/repo", branch: "held", profile: "yolo" },
      deps,
    );
    const waiting = waitForWorktree(sessionId, deps.getMetadata, {
      prompt,
      patchMetadata: deps.patchMetadata,
    });
    await settle();
    expect(pendingPromptOf(metadata.get(sessionId))).toEqual(prompt);

    finish();
    await waiting;
    expect(pendingPromptOf(metadata.get(sessionId))).toBeUndefined();
  });

  test("an ordinary session never stores it", async () => {
    const patched: string[] = [];
    await waitForWorktree("plain", () => ({}), {
      prompt,
      patchMetadata: (id) => patched.push(id),
    });
    expect(patched).toEqual([]);
  });
});

describe("resumeInterruptedSetups", () => {
  test("runs a setup the restart cut off again, from the request it recorded", async () => {
    const first = fakeDeps();
    const { sessionId, cwd } = startWorktreeSession(
      { folder: "/repo", branch: "cut-off", base: "origin/main", profile: "yolo" },
      first.deps,
    );
    // The next process: same row, nothing running for it.
    const { deps, metadata, finish } = fakeDeps();
    metadata.set(sessionId, { ...first.metadata.get(sessionId) });
    first.finish();
    await settle();
    const requests: unknown[] = [];
    const createWorktree = deps.createWorktree;
    deps.createWorktree = (request) => {
      requests.push(request);
      return createWorktree(request);
    };

    expect(resumeInterruptedSetups([sessionId], { ...deps, cwdOf: () => cwd })).toBe(1);
    expect(requests).toEqual([
      { branch: "cut-off", base: "origin/main", folder: "/repo", profile: "yolo" },
    ]);
    expect(isWorktreeSetupPending(sessionId)).toBe(true);

    finish();
    await settle();
    expect(metadata.get(sessionId)?.[WORKTREE_SETUP_KEY]).toBeUndefined();
  });

  test("fails an older setup with no request, unless its worktree already exists", () => {
    const made = join(ROOT, "made");
    mkdirSync(join(made, ".git"), { recursive: true });
    const running = { state: "running", branch: "b", startedAt: "2026-11-09T20:00:00.000Z" };
    const metadata = new Map<string, Record<string, unknown>>([
      ["cut", { [WORKTREE_SETUP_KEY]: running }],
      ["made", { [WORKTREE_SETUP_KEY]: running }],
    ]);
    const announced: string[] = [];
    const { deps } = fakeDeps();

    const settled = resumeInterruptedSetups(["cut", "made"], {
      ...deps,
      getMetadata: (id) => metadata.get(id),
      patchMetadata: (id, patch) => metadata.set(id, { ...metadata.get(id), ...patch }),
      announce: (id) => announced.push(id),
      cwdOf: (id) => (id === "made" ? made : join(ROOT, "missing")),
    });

    expect(settled).toBe(2);
    expect(worktreeSetupOf(metadata.get("cut"))).toMatchObject({
      state: "failed",
      error: "Setup was interrupted by a restart",
    });
    expect(metadata.get("made")?.[WORKTREE_SETUP_KEY]).toBeNull();
    expect(announced).toEqual(["cut", "made"]);
  });
});
