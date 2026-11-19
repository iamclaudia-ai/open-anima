/**
 * A new session in a fresh worktree, without making anyone wait for it.
 *
 * Bootstrapping a worktree fetches origin, checks out the tree and seeds
 * CodeGraph: seconds in a small repo, a minute or two in a big monorepo.
 * `session.create_session` used to do all of that before answering, so the
 * New Session dialog sat on "Creating worktree..." the whole time.
 *
 * Now the session is registered at once, in the folder the worktree will
 * occupy, with `metadata.worktreeSetup` saying the folder is still being made.
 * The bootstrap runs in the background; when it finishes the marker is
 * cleared (or turned into the error), and `session.list_changed` tells every
 * tab. A prompt sent before then waits for the setup instead of starting
 * Claude in a folder that doesn't exist yet.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { animaLogFile, createLogger, shortId } from "@anima/shared";
import {
  checkWorktreeOptions,
  validateWorktreeBranch,
  worktreePathFor,
  type WorktreeRequest,
} from "../worktree";

const log = createLogger("SessionExt:WorktreeSession", animaLogFile("session.log"));

/** The metadata key the UI reads; absent once the worktree is ready. */
export const WORKTREE_SETUP_KEY = "worktreeSetup";

export interface WorktreeSetup {
  state: "running" | "failed";
  branch: string;
  startedAt: string;
  /** Why it failed (the bootstrap's last lines). */
  error?: string;
  /** What the bootstrap was asked, so a restart can run it again (it reuses what exists). */
  request?: SetupRequest;
}

export interface SetupRequest {
  folder: string;
  base?: string;
  profile: string;
}

type SetupRunDeps = Pick<
  WorktreeSessionDeps,
  "createWorktree" | "moveSession" | "patchMetadata" | "announce"
>;

export interface WorktreeSessionDeps {
  /** The main checkout of the repo `folder` is in. */
  repoFor: (folder: string) => string;
  /**
   * File the not-yet-existing folder under the repo's workspace, so the
   * session lands there before git has made the folder.
   */
  claimFolder: (repo: string, path: string) => void;
  /** Register the draft session in `cwd` with the given metadata; nothing runs yet. */
  createDraft: (
    cwd: string,
    metadata: Record<string, unknown>,
  ) => { sessionId: string; workspaceId: string };
  setTitle: (sessionId: string, title: string) => void;
  createWorktree: (request: WorktreeRequest) => Promise<{ path: string }>;
  /** Merge into the session's metadata; a null value removes the key. */
  patchMetadata: (sessionId: string, patch: Record<string, unknown>) => void;
  getMetadata: (sessionId: string) => Record<string, unknown> | null | undefined;
  /** The bootstrap put the worktree somewhere else (a project's own script): follow it. */
  moveSession: (sessionId: string, from: string, to: string) => void;
  /** Tell every tab the session's row changed. */
  announce: (sessionId: string) => void;
}

export interface WorktreeSessionRequest {
  /** Any folder in the repo; usually the workspace root the dialog was opened on. */
  folder: string;
  branch: string;
  base?: string;
  profile: string;
  title?: string | null;
}

/** Setups still running in this process, by session. */
const pending = new Map<string, Promise<void>>();

/**
 * Register the session in its future worktree and start the bootstrap.
 * Returns as soon as the session exists. Bad input (an invalid branch, a
 * folder outside git) still throws here, before anything is created.
 */
export function startWorktreeSession(
  request: WorktreeSessionRequest,
  deps: WorktreeSessionDeps,
): { sessionId: string; workspaceId: string; cwd: string; title: string | null } {
  checkWorktreeOptions({ worktree: request.branch, worktreeBase: request.base });
  const branch = validateWorktreeBranch(request.branch);
  const repo = deps.repoFor(request.folder);
  const cwd = worktreePathFor(repo, branch);

  deps.claimFolder(repo, cwd);
  const setup: WorktreeSetup = {
    state: "running",
    branch,
    startedAt: new Date().toISOString(),
    request: {
      folder: request.folder,
      ...(request.base ? { base: request.base } : {}),
      profile: request.profile,
    },
  };
  const { sessionId, workspaceId } = deps.createDraft(cwd, { [WORKTREE_SETUP_KEY]: setup });
  const title = request.title?.trim() || null;
  if (title) deps.setTitle(sessionId, title);

  runSetup(sessionId, cwd, setup, setup.request!, deps);
  return { sessionId, workspaceId, cwd, title };
}

/** Run the bootstrap in the background; a prompt sent meanwhile waits for it (`waitForWorktree`). */
function runSetup(
  sessionId: string,
  cwd: string,
  setup: WorktreeSetup,
  request: SetupRequest,
  deps: SetupRunDeps,
): void {
  const run = deps
    .createWorktree({
      branch: setup.branch,
      base: request.base,
      folder: request.folder,
      profile: request.profile,
    })
    .then((created) => {
      if (created.path !== cwd) deps.moveSession(sessionId, cwd, created.path);
      deps.patchMetadata(sessionId, { [WORKTREE_SETUP_KEY]: null });
      log.info("Worktree session ready", { sessionId: shortId(sessionId), path: created.path });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      deps.patchMetadata(sessionId, {
        [WORKTREE_SETUP_KEY]: { ...setup, state: "failed", error: message } satisfies WorktreeSetup,
      });
      log.error("Worktree session setup failed", { sessionId: shortId(sessionId), error: message });
    })
    .finally(() => {
      pending.delete(sessionId);
      deps.announce(sessionId);
    });
  pending.set(sessionId, run);
}

/** The session's setup marker, when it has one. */
export function worktreeSetupOf(
  metadata: Record<string, unknown> | null | undefined,
): WorktreeSetup | undefined {
  const value = metadata?.[WORKTREE_SETUP_KEY] as Partial<WorktreeSetup> | null | undefined;
  if (!value || (value.state !== "running" && value.state !== "failed")) return undefined;
  if (typeof value.branch !== "string" || typeof value.startedAt !== "string") return undefined;
  const request = value.request;
  const usable =
    request && typeof request.folder === "string" && typeof request.profile === "string";
  return {
    state: value.state,
    branch: value.branch,
    startedAt: value.startedAt,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(usable ? { request } : {}),
  };
}

/** The metadata key a prompt waiting on the worktree is kept under, so a restart can't lose it. */
export const PENDING_PROMPT_KEY = "pendingPrompt";

export interface PendingPrompt {
  content: string | unknown[];
  model?: string;
  agent: string;
  source?: string;
  queuedAt: string;
}

/** The prompt still waiting on the session's worktree, when there is one. */
export function pendingPromptOf(
  metadata: Record<string, unknown> | null | undefined,
): PendingPrompt | undefined {
  const value = metadata?.[PENDING_PROMPT_KEY] as Partial<PendingPrompt> | null | undefined;
  if (!value || typeof value.agent !== "string" || typeof value.queuedAt !== "string") {
    return undefined;
  }
  if (typeof value.content !== "string" && !Array.isArray(value.content)) return undefined;
  return value as PendingPrompt;
}

/**
 * Hold a prompt until the session's worktree exists. Resolves at once for
 * every other session; throws when the setup failed, since the session has
 * no folder to run in. While it waits, `hold` keeps the prompt on the
 * session's row: a restart kills this call, and the next process sends it
 * once the resumed setup is done (`pendingPromptOf`).
 */
export async function waitForWorktree(
  sessionId: string,
  getMetadata: WorktreeSessionDeps["getMetadata"],
  hold?: { prompt: PendingPrompt; patchMetadata: WorktreeSessionDeps["patchMetadata"] },
): Promise<void> {
  const running = pending.get(sessionId);
  if (running) {
    log.info("Prompt waiting for worktree setup", { sessionId: shortId(sessionId) });
    hold?.patchMetadata(sessionId, { [PENDING_PROMPT_KEY]: hold.prompt });
    try {
      await running;
    } finally {
      // It goes out now (or fails with the setup): either way it's no longer waiting.
      hold?.patchMetadata(sessionId, { [PENDING_PROMPT_KEY]: null });
    }
  }
  const setup = worktreeSetupOf(getMetadata(sessionId));
  if (setup?.state === "failed") {
    throw new Error(
      `The worktree for ${setup.branch} couldn't be set up: ${setup.error ?? "unknown error"}`,
    );
  }
}

/**
 * Setups this process isn't running were cut off by a restart (their script
 * died with the old extension). One that recorded its request runs again: the
 * bootstrap reuses the branch and worktree it already made, and a prompt that
 * was waiting on it (`pendingPrompt`) goes out once it's done. An older marker
 * without one is marked failed so nothing waits forever, unless its worktree
 * got far enough to exist: then only the marker goes.
 */
export function resumeInterruptedSetups(
  sessionIds: string[],
  deps: Pick<WorktreeSessionDeps, "getMetadata"> &
    SetupRunDeps & {
      cwdOf: (sessionId: string) => string | null | undefined;
    },
): number {
  let settled = 0;
  for (const sessionId of sessionIds) {
    if (pending.has(sessionId)) continue;
    const setup = worktreeSetupOf(deps.getMetadata(sessionId));
    if (setup?.state !== "running") continue;
    const cwd = deps.cwdOf(sessionId);
    if (setup.request && cwd) {
      log.info("Resuming worktree setup cut off by a restart", {
        sessionId: shortId(sessionId),
        branch: setup.branch,
      });
      runSetup(sessionId, cwd, setup, setup.request, deps);
      settled++;
      continue;
    }
    const usable = Boolean(cwd && existsSync(join(cwd, ".git")));
    deps.patchMetadata(sessionId, {
      [WORKTREE_SETUP_KEY]: usable
        ? null
        : ({
            ...setup,
            state: "failed",
            error: "Setup was interrupted by a restart",
          } satisfies WorktreeSetup),
    });
    deps.announce(sessionId);
    settled++;
  }
  return settled;
}

/** For tests: whether a setup is still in flight. */
export function isWorktreeSetupPending(sessionId: string): boolean {
  return pending.has(sessionId);
}
