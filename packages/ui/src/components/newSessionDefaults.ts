import type { WorkspaceInfo } from "../hooks/useChatGateway";

/**
 * The workspace a new session most likely belongs in: the one being viewed,
 * which is where the user last was. Without one, the one with the latest
 * transcript write. That is a weak signal while several agents are running
 * (they write within seconds of each other), so it is only the fallback.
 * Pinning only orders the list, so it plays no part here.
 */
export function defaultWorkspace(
  workspaces: WorkspaceInfo[],
  currentWorkspaceId: string | null | undefined,
): WorkspaceInfo | null {
  const current = workspaces.find((w) => w.id === currentWorkspaceId);
  if (current) return current;
  let best: WorkspaceInfo | null = null;
  for (const workspace of workspaces) {
    if (!best || workspace.updatedAt > best.updatedAt) best = workspace;
  }
  return best;
}

/**
 * A worktree branch name suggested by a session title: "Fix the iOS
 * login bug!" becomes `fix-the-ios-login-bug`. Keeps only what
 * `validateWorktreeBranch` accepts, and returns "" when nothing usable is left.
 */
export function branchFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/(^|\/)[.-]+/g, "$1")
    .replace(/[./-]+$/g, "")
    .replace(/^\/+/, "");
}

/**
 * Workspaces matching what was typed into the workspace picker, best first:
 * name prefix, then a word of the name (`mob` finds `store-mobile`), then
 * anywhere in the name, then the folder path, then the letters in order
 * (`evm`). Ties keep the list's own order (pinned, then recent). An empty
 * query matches everything, unchanged.
 */
export function matchWorkspaces(workspaces: WorkspaceInfo[], query: string): WorkspaceInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return workspaces;
  const rank = (workspace: WorkspaceInfo): number => {
    const name = workspace.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.split(/[\s\-_./]+/).some((word) => word.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if (workspace.cwdDisplay.toLowerCase().includes(q)) return 3;
    let at = 0;
    for (const char of name) if (char === q[at]) at++;
    return at === q.length ? 4 : -1;
  };
  return workspaces
    .map((workspace, index) => ({ workspace, index, score: rank(workspace) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((m) => m.workspace);
}
