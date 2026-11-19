# chat

The chat extension is the web chat: the `/chat` pages where you pick a workspace, see its sessions and the ACTIVE
queue, and talk to Lumen. It has no server methods and no events of its own. Its server half (`src/index.ts`) only
exists so the gateway loads it and serves its web bundle; everything it does goes through `session.*` methods and
events (see [session.md](session.md)). Most of the UI lives in `packages/ui`, which the extension composes into a
two-panel layout. The pieces in `packages/ui` are shared: the gateway's web shell renders the attention banner on
every page, and other clients can embed `AnimaChat` directly.

## Methods

None. `chat` does not appear in `gateway.list_methods`, and `anima chat --help` reports an unknown namespace.
`health()` returns `{ ok: true }`.

## Web pages

From `src/routes.ts`. All three use the `ide` layout.

| Route                           | Shows                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/chat`                         | Redirects to the first workspace's `latest` session.                                                                                            |
| `/chat/:workspaceId`            | Redirects to `/chat/:workspaceId/latest`.                                                                                                       |
| `/chat/:workspaceId/:sessionId` | The chat. `sessionId` may be the sentinel `latest`, resolved to the session last opened in that workspace in this browser, else the newest one. |

The web contribution (default export of `src/routes.ts`) also declares:

- The launcher tile on `/`: label `Chat` (the contribution's `name`), icon `MessageSquare`, rose colors,
  `order: 40`. It links to the first route.
- Two panels: `chat.nav` ("Workspaces", width clamped to 220 to 320 px, `NavPanel`) and `chat.main` ("Chat",
  `ChatPanel`).
- The `ide` layout: on desktop the nav (280 px) left of the chat; on mobile the chat alone, with the nav as an overlay
  drawer. `ChatPageProvider` is installed as the layout's provider so both panels share one state.

The gateway finds the routes file by convention (`extensions/<id>/src/routes.ts`, see
`packages/gateway/src/web/extension-bundler.ts`) and serves the bundle at `/extensions/chat/web-bundle.js`.

## Config

`extensions.chat.config` is read by nothing; the example's `{}` is all there is. The page uses the gateway it was
served from (`ws(s)://<page host>/ws`).

## How it works

### State: `ChatPageProvider` (`src/context/ChatPageContext.tsx`)

The URL is the only source of the current selection. Handlers never set the active workspace or session; they call
`navigate()`, and the provider derives `activeWorkspace` and `activeSessionId` from the route params.

On mount it loads `session.list_workspaces`, then one page of `session.list_sessions` (5 rows) per workspace. "Show
more" fetches further pages of 5. Opening a workspace refetches its first page.

It subscribes to the three broadcast events and handles them differently:

| Event                    | Effect                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `session.status_changed` | Patch the row in place (runtime status, disposition, title, first prompt). Never re-sorts.           |
| `session.activity`       | The same patch, on the heartbeat, so a row that missed a transition corrects itself within a second. |
| `session.list_changed`   | Refetch that workspace's list, at least as many rows as are showing.                                 |

Actions and the methods behind them:

| Action                                          | Calls                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| New session (button, or the New Session dialog) | `session.create_session` with `origin: "user"`, optional `title` and `worktree`; optimistic row, then navigate |
| New workspace (folder browser)                  | `session.get_directories`, then `session.get_or_create_workspace`; opens its newest session or creates one     |
| Rename                                          | `session.set_title` (optimistic, rolled back on failure)                                                       |
| Set status, mark done                           | `session.set_status`                                                                                           |
| Search                                          | `session.search` (limit 20)                                                                                    |
| Pin a workspace                                 | `session.set_workspace_pinned`                                                                                 |
| Workspace folders dialog                        | `session.get_workspace`, `session.update_workspace`                                                            |

Per browser, in `localStorage`: the last session opened in each workspace
(`anima:workspace:<workspaceId>:latestSession`) and the unsent draft for each session
(`anima:draft:<workspaceId>:<sessionId>`, from `src/app.ts`).

### The nav: `NavPanel` (`src/panels/NavPanel.tsx`)

Renders `NavigationDrawer` from `packages/ui` with two tabs:

- **Active**: the ACTIVE queue from `useAttentionSessions` (`session.list_attention`). Rows are grouped by
  `packages/ui/src/components/active-pane-groups.ts`: a subagent nests under its parent, a launched session under its
  launcher when that row is listed; a `user` session never nests under an `automated` launcher; automated, unpinned
  top-level rows go in a collapsed Background group. Rows can be pinned (`session.set_pinned`) and marked done.
- **Workspaces**: the tree, each workspace with its first page of sessions, PR/ticket chips, folder chips for
  worktree sessions, and the per-session menu.

It also hosts `CreateWorkspaceModal`, `NewSessionModal` (workspace picker, title, optional worktree branch suggested
from the title) and `WorkspaceFoldersModal`. Workspace menu items other than pin, refresh and folders, and settings
items other than logout, are stubs that only log.

### The conversation: `ChatPanel` (`src/panels/ChatPanel.tsx`)

Fills the app header's slots: a nav toggle (adds or removes the `chat.nav` panel on desktop, opens the drawer on
mobile), a home link, the workspace name, the session's `SessionMenu`, and a connection dot. The menu's state comes
from `src/panels/session-menu-state.ts`, which prefers the ACTIVE queue's copy of the session (fresher, and the only
one that knows `pinned`) over the workspace list's.

Above the chat it shows two strips, both driven by the session's list row:

- `HandoffLinks`: "Continued from …" and "Continued in …" links from `previousSessionId` and `handedOffTo`.
- `WorktreeSetupStrip`: a timer while the session's worktree is being made, or the error if it failed. You can send a
  message meanwhile; the server holds it until the worktree is ready.

Then `AnimaChat` with the session id and workspace id, remounted whenever either changes. Its `onHandoff` navigates
to the new session with a normal push, so Back still reaches the old transcript.

### What `packages/ui` does for it

| Piece                                                                              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/AnimaChat.tsx`                                                         | The chat view: message list, input, thinking indicator, status bar, compaction indicator, subagent strip.                                                                                                                                                                                                                                                                                                                                                                           |
| `hooks/useChatGateway.ts`                                                          | Session state over the gateway: subscribes to `session.<id>.*`, loads `get_history` (50 per page, older pages from a "load earlier" button) and `list_subagents`, sends `send_prompt` (text plus images and files as base64 content blocks, with the workspace root as `cwd`), `interrupt_session`, `send_tool_result`, `answer_modal` (with the prompt's fingerprint), and follows the `handoff` event (calls `onHandoff`, or adopts the new session in place when there is none). |
| `hooks/useAttentionSessions.ts`                                                    | One shared store per tab for the ACTIVE queue: refetches 1 s after a `status_changed` or `list_changed`, patches rows on `session.activity`, polls every 60 s, re-checks thresholds every 30 s. Its `acknowledge` resolves the session.                                                                                                                                                                                                                                             |
| `components/AttentionBanner.tsx`                                                   | App-wide banner (rendered by `packages/gateway/src/web/index.tsx`) for sessions waiting on you: 15 min after a turn ends, 45 s after a session blocks on a prompt or API error, stops after 24 h. Automated sessions never raise it unless pinned. Offers open, snooze (30 min), done and dismiss (dismiss hides it in this tab only). The session you are looking at is left out.                                                                                                  |
| `components/NavigationDrawer.tsx`                                                  | Sidebar: fixed top actions, Active / Workspaces tabs, search modal, settings menu.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `components/active-pane-groups.ts`                                                 | Pure nesting and Background rules for the Active tab.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `components/SessionMenu.tsx`                                                       | The ⋯ menu shared by tree rows, queue rows and the chat header: mark done, pin, copy a `tmux attach` command, rename, set any disposition.                                                                                                                                                                                                                                                                                                                                          |
| `components/NewSessionModal.tsx`, `newSessionDefaults.ts`                          | New session dialog: default workspace (the one in view, else latest activity), fuzzy workspace match, branch name from title.                                                                                                                                                                                                                                                                                                                                                       |
| `components/CreateWorkspaceModal.tsx`, `components/WorkspaceFoldersModal.tsx`      | Folder browser for new workspaces; folder add/remove/root/move for an existing one.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `components/MessageList.tsx`, `MessageContent.tsx`, `ToolCallBlock.tsx`, `tools/*` | Transcript rendering, with a renderer per Claude Code tool.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `components/ModalPromptBlock.tsx`                                                  | A permission or trust prompt the CLI is blocked on, with its option buttons.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `components/InputArea.tsx`, `CommandPicker.tsx`, `FilePicker.tsx`                  | Composer; `/` lists skills and commands (`session.list_commands`), `@` lists files (`session.list_files`).                                                                                                                                                                                                                                                                                                                                                                          |
| `components/GitStatusBar.tsx`, `ContextRing.tsx`, `CompactionIndicator.tsx`        | Branch, dirty state and PR (from `git_status`); context use; the idle auto-compaction countdown when `get_history` reports `idleCompaction`.                                                                                                                                                                                                                                                                                                                                        |
| `components/SubagentActivityStrip.tsx`                                             | Running children of the session on screen.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `components/LayoutManager.tsx`, `contexts/HeaderSlotsContext.tsx`                  | The dockview layout that hosts the panels, and `useHeaderSlot`, through which panels fill the shared header.                                                                                                                                                                                                                                                                                                                                                                        |
| `router.tsx`                                                                       | The pushState router (`navigate`, `Link`, `useRouter`, `matchPath`).                                                                                                                                                                                                                                                                                                                                                                                                                |

## Gotchas

- **The tmux command ignores the instance's prefix.** `SessionMenu` copies `tmux attach -t anima-claude-<id>`, but
  agent-host names panes `<agentHost.tmuxPrefix>-claude-<id>`. On an instance with another prefix the copied command
  attaches to nothing.
- **Search depends on the memory extension.** The nav's search calls `session.search`, which calls
  `memory.search_transcripts`; with memory disabled, search fails.
- **"Snoozed" in the menu is not a snooze.** It sets the disposition through `set_status` with no timer, so the session
  stays in the Active tab with a snoozed mark. Only the banner's Snooze (`session.snooze`) hides it for a while.
- **The selection lives in the URL.** Anything that changes the open session should `navigate()` to
  `/chat/<workspaceId>/<sessionId>`; setting state directly is overwritten by the next render.
- **Lists are patched, not re-sorted.** Live events change what a row says, never where it sits; order changes only on
  a refetch. Code that inserts rows should go through a refetch (`session.list_changed`) rather than guess positions.
- **Each workspace starts with 5 sessions loaded.** An old session opened by URL may not be in its workspace's list,
  so the header menu falls back to the queue's copy, and the handoff and worktree strips need the row to be loaded.

## Code map

| File                                     | Role                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/index.ts`                           | Server half: no methods, no events, `health()` only                                    |
| `src/routes.ts`                          | Routes, panels, the `ide` layout, the launcher tile                                    |
| `src/app.ts`                             | Gateway URL and the platform bridge (per-session draft storage, clipboard)             |
| `src/context/ChatPageContext.tsx`        | `ChatPageProvider` / `useChatPage`: all gateway calls, URL redirects, live list events |
| `src/pages/helpers/main-page-gateway.ts` | `list_sessions` paging and `create_session` with `origin: "user"`                      |
| `src/panels/NavPanel.tsx`                | Sidebar panel and its modals                                                           |
| `src/panels/ChatPanel.tsx`               | Chat panel, header slots, mobile drawer                                                |
| `src/panels/HandoffLinks.tsx`            | Handoff chain strip                                                                    |
| `src/panels/WorktreeSetupStrip.tsx`      | Worktree setup strip                                                                   |
| `src/panels/session-menu-state.ts`       | Merges list and queue state for the header menu                                        |
