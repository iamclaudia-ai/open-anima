/**
 * The real wiring for `startWorktreeSession`: the workspace registry, the
 * session store and the bus. Kept apart from the lifecycle so its tests run
 * without a database.
 */

import { animaLogFile, createLogger, shortId } from "@anima/shared";
import { existsSync } from "node:fs";
import {
  PENDING_PROMPT_KEY,
  type PendingPrompt,
  pendingPromptOf,
  resumeInterruptedSetups,
  type WorktreeSessionDeps,
} from "./lifecycle/worktree-session";
import { getRuntime } from "./runtime";
import { emitListChanged } from "./session-status-events";
import {
  getStoredSession,
  listSessionsInWorktreeSetup,
  listSessionsWithPendingPrompt,
  setSessionCwd,
  setSessionTitle,
  updateSessionMetadata,
} from "./session-store";
import { createWorktree, worktreeRepoFor } from "./worktree";
import { getWorkspaceByCwd, getWorkspaceDb } from "./workspace-db";
import { addWorkspaceFolder } from "./workspace-folders";

const log = createLogger("SessionExt:WorktreeSession", animaLogFile("session.log"));

const patchMetadata: WorktreeSessionDeps["patchMetadata"] = (sessionId, patch) =>
  void updateSessionMetadata(sessionId, patch);
const getMetadata: WorktreeSessionDeps["getMetadata"] = (sessionId) =>
  getStoredSession(sessionId)?.metadata;
const announce: WorktreeSessionDeps["announce"] = (sessionId) => {
  const workspaceId = getStoredSession(sessionId)?.workspaceId;
  if (workspaceId) emitListChanged(workspaceId, "worktree_setup");
};

const moveSession: WorktreeSessionDeps["moveSession"] = (sessionId, from, to) => {
  getRuntime().registry.getOrCreateWorkspace(to);
  setSessionCwd(sessionId, to);
  // The folder claimed for the expected path never came to be.
  if (!existsSync(from)) {
    getWorkspaceDb()
      .query("DELETE FROM workspace_folders WHERE path = ? AND kind = 'worktree'")
      .run(from);
  }
};

/** On startup: resume (or settle) setups the previous process was running when it stopped. */
export function resumeInterruptedWorktreeSetups(): number {
  return resumeInterruptedSetups(listSessionsInWorktreeSetup(), {
    getMetadata,
    patchMetadata,
    announce,
    createWorktree: (request) => createWorktree(request),
    moveSession,
    cwdOf: (sessionId) => getStoredSession(sessionId)?.cwd,
  });
}

/**
 * Once agent-host is reachable: send the prompts a restart caught waiting on a worktree. Each
 * goes through the normal prompt path, so it waits again for its resumed setup.
 */
export function deliverPendingPrompts(
  send: (sessionId: string, prompt: PendingPrompt) => Promise<unknown>,
): number {
  const sessionIds = listSessionsWithPendingPrompt();
  for (const sessionId of sessionIds) {
    const prompt = pendingPromptOf(getMetadata(sessionId));
    if (!prompt) continue;
    log.info("Sending a prompt a restart caught waiting on its worktree", {
      sessionId: shortId(sessionId),
      queuedAt: prompt.queuedAt,
    });
    // Taken off the row first: while it waits again for the resumed setup, the prompt path
    // puts it back (and takes it off when it goes out), so it's sent once.
    patchMetadata(sessionId, { [PENDING_PROMPT_KEY]: null });
    send(sessionId, prompt).catch((error: unknown) => {
      log.warn("Pending prompt didn't go out", {
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return sessionIds.length;
}

export function worktreeSessionDeps(
  createDraft: WorktreeSessionDeps["createDraft"],
): WorktreeSessionDeps {
  return {
    repoFor: worktreeRepoFor,
    claimFolder: (repo, path) => {
      if (getWorkspaceByCwd(path)) return;
      const { workspace } = getRuntime().registry.getOrCreateWorkspace(repo);
      addWorkspaceFolder(workspace.id, path, "worktree");
    },
    createDraft,
    setTitle: (sessionId, title) => void setSessionTitle(sessionId, title),
    createWorktree: (request) => createWorktree(request),
    patchMetadata,
    getMetadata,
    moveSession,
    announce,
  };
}
