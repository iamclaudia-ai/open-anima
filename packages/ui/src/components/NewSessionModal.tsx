import { useState } from "react";
import { GitBranch, X } from "lucide-react";
import type { WorkspaceInfo } from "../hooks/useChatGateway";
import { branchFromTitle, defaultWorkspace } from "./newSessionDefaults";
import { WorkspaceCombobox } from "./WorkspaceCombobox";

export interface NewSessionRequest {
  workspace: WorkspaceInfo;
  /** Empty means the title comes from the first prompt, as before. */
  title: string;
  /** Branch for a new worktree, or null to start in the workspace's own folder. */
  worktree: string | null;
}

interface NewSessionModalProps {
  isOpen: boolean;
  workspaces: WorkspaceInfo[];
  /** The workspace being viewed, preselected when present. */
  currentWorkspaceId?: string | null;
  onClose: () => void;
  /** Rejects with the server's message when the session can't be made. */
  onSubmit: (request: NewSessionRequest) => Promise<void>;
}

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none placeholder:text-gray-300 disabled:bg-gray-50";

/**
 * Start a session anywhere, in one step: pick the workspace (the one being
 * viewed is preselected), optionally name it, and optionally put it in a fresh
 * worktree. Reachable from either nav tab, so it works on a phone, where the
 * workspace rows' hover actions don't.
 */
export function NewSessionModal({ isOpen, ...props }: NewSessionModalProps) {
  // Mounted only while open, so every open starts from a fresh form.
  return isOpen ? <NewSessionForm {...props} /> : null;
}

function NewSessionForm({
  workspaces,
  currentWorkspaceId,
  onClose,
  onSubmit,
}: Omit<NewSessionModalProps, "isOpen">) {
  // Until the user picks one, the default is derived, so it appears even when
  // the dialog opened before the workspace list loaded. A pick is kept as is.
  const [pickedId, setWorkspaceId] = useState<string | null>(null);
  const workspaceId = pickedId ?? defaultWorkspace(workspaces, currentWorkspaceId)?.id ?? "";
  const [title, setTitle] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  // Once the branch is typed by hand, the title stops rewriting it.
  const [branchEdited, setBranchEdited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const branchName = branch.trim();
  const canSubmit = Boolean(workspace) && (!useWorktree || branchName) && !isCreating;

  const onTitleChange = (value: string) => {
    setTitle(value);
    if (!branchEdited) setBranch(branchFromTitle(value));
  };

  const submit = async () => {
    if (!workspace || !canSubmit) return;
    setIsCreating(true);
    setError(null);
    try {
      await onSubmit({ workspace, title: title.trim(), worktree: useWorktree ? branchName : null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsCreating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !isCreating) {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-gradient-to-b from-black/10 to-black/20 pt-[12vh] backdrop-blur-xs"
      onKeyDown={onKeyDown}
    >
      <div className="mx-4 w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">New Session</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            aria-label="Close"
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">Workspace</span>
            <WorkspaceCombobox
              workspaces={workspaces}
              selectedId={workspaceId}
              onSelect={setWorkspaceId}
              disabled={isCreating}
              className={inputClass}
            />
            {workspace && (
              <p className="mt-1 truncate font-mono text-xs text-gray-500">
                {workspace.cwdDisplay}
              </p>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Title <span className="font-normal text-gray-400">(optional)</span>
            </span>
            <input
              type="text"
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="What this session is for"
              disabled={isCreating}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500">Defaults to the first message</p>
          </label>

          <div className="rounded-lg border border-gray-200">
            <label className="flex cursor-pointer items-start gap-3 p-3 hover:bg-gray-50">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
                disabled={isCreating}
                className="mt-0.5 size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <span className="block text-sm font-medium text-gray-800">
                  Create a new worktree
                </span>
                <p className="mt-1 text-xs text-gray-500">
                  A fresh branch from origin's default branch, beside the repo, set up in the
                  background while you start typing. Unchecked, the session works in the current
                  checkout.
                </p>
              </div>
            </label>
            {useWorktree && (
              <label className="block border-t border-gray-200 p-3">
                <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <GitBranch className="size-3.5" /> Branch
                </span>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setBranchEdited(true);
                  }}
                  placeholder="fix-login-bug"
                  disabled={isCreating}
                  className={`${inputClass} font-mono`}
                />
                <p className="mt-1 text-xs text-gray-500">
                  An existing branch's worktree is reused.
                </p>
              </label>
            )}
          </div>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? "Creating..." : "Start Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
