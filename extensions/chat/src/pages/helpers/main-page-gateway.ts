import type { SessionInfo } from "@anima/ui";

export type GatewayCaller = (
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export interface ListSessionsResult {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
}

/**
 * Fetch sessions for a workspace. When `limit` is omitted, returns all
 * sessions (legacy behavior). With `limit`/`offset` set, the server
 * paginates and `hasMore` reflects whether further pages remain.
 */
export async function loadSessionsForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
  options?: { limit?: number; offset?: number },
): Promise<ListSessionsResult> {
  const payload = (await callGateway("session.list_sessions", {
    cwd,
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.offset !== undefined ? { offset: options.offset } : {}),
  })) as { sessions?: SessionInfo[]; total?: number; hasMore?: boolean } | null;
  const sessions = payload?.sessions ?? [];
  return {
    sessions,
    total: payload?.total ?? sessions.length,
    hasMore: payload?.hasMore ?? false,
  };
}

export interface NewSessionOptions {
  title?: string;
  /** Branch for a new (or reused) worktree; the session starts there. */
  worktree?: string;
}

export async function createSessionForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
  options: NewSessionOptions = {},
): Promise<{ sessionId: string; workspaceId: string | null } | null> {
  // With a worktree the server answers at once and builds it in the
  // background; the row's `worktreeSetup` tracks it (WorktreeSetupStrip).
  const payload = (await callGateway("session.create_session", {
    cwd,
    // The user's own session: it stays in the user's ACTIVE list, not Background.
    origin: "user",
    ...(options.title ? { title: options.title } : {}),
    ...(options.worktree ? { worktree: options.worktree } : {}),
  })) as { sessionId?: string; workspaceId?: string } | null;
  if (!payload?.sessionId) return null;
  return { sessionId: payload.sessionId, workspaceId: payload.workspaceId ?? null };
}
