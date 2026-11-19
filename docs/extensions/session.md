# session

The session extension owns every session and workspace in Anima. It is the only component that talks to agent-host:
it keeps one WebSocket open to it (`agentHost.url`, authenticated with `gateway.token`), turns gateway method calls into
agent-host requests (create, prompt, interrupt, close, spawn), and re-emits agent-host's stream events on the gateway
bus. Around that it keeps the registry the rest of the system reads: workspaces and their folders, a `sessions` table
that mirrors the Claude Code transcripts on disk, two status axes per session (what the agent is doing, and where the
work stands), the ACTIVE queue, subagents, handoffs and worktrees.

Who uses it:

- The web chat (`extensions/chat` plus `packages/ui`) calls most of the methods below.
- `today` creates, titles, prompts and resolves sessions for board items, and reads `list_attention`.
- `memory` (Scribe) creates, prompts, reads and closes its summarizer sessions.
- The CLI (`anima session …`), and through it every agent session (handoff, spawn_agent, set_status).

What it uses:

- `ctx.call("memory.transition_conversation")` and `ctx.call("memory.get_session_context")` when a new session is
  bootstrapped (1.5 s and 2 s timeouts, failures are logged and ignored).
- `ctx.call("memory.search_transcripts")` for `session.search`.
- The `memory_transcript_entries` table directly (same `anima.db`) for PR/ticket ref extraction
  (`src/session-ref-sync.ts`).
- `git` and `gh` (branch, dirty state, open PR at the end of each turn; `gh auth token` for ref validation).

## Methods

All 39 methods. The lane column is the method's `execution` policy
(`packages/extension-host/src/request-scheduler.ts`): `read · parallel` runs at once; `serial` waits behind every other
call on the same lane; `keyed(x)` waits only behind calls on the same lane with the same value of param `x`;
`control · parallel` runs at once.

### Sessions

| Method                | Lane                            | Purpose                                                                                                                          | Notable params                                                                                                                                                                                                      |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_session`      | write · serial                  | Register a draft session (nothing runs until the first prompt). Returns `{ sessionId, workspaceId, cwd, title }`.                | `cwd` (required), `title`, `agent` (default `claude`), `model`, `systemPrompt`, `thinking`, `effort`, `profile` (default `yolo`), `origin` (default `automated`), `launchedBySessionId`, `worktree`, `worktreeBase` |
| `send_prompt`         | long_running · keyed(sessionId) | Send a prompt. Streaming returns `{ status: "streaming" }` once dispatched; non-streaming waits up to 5 min for the turn's text. | `sessionId`, `content` (string or content blocks), `cwd`, `model`, `agent`, `streaming` (default true), `source`                                                                                                    |
| `interrupt_session`   | write · keyed(sessionId)        | Interrupt the current turn.                                                                                                      | `sessionId`                                                                                                                                                                                                         |
| `answer_modal`        | write · keyed(sessionId)        | Answer a permission/trust prompt the CLI is blocked on.                                                                          | `sessionId`, `key` (option key as rendered), `fingerprint` (rejects a stale prompt)                                                                                                                                 |
| `close_session`       | write · keyed(sessionId)        | Close the runtime and mark the row `status = archived`.                                                                          | `sessionId`                                                                                                                                                                                                         |
| `switch_session`      | write · keyed(sessionId)        | Resume a session in its own folder and make it the workspace's active one.                                                       | `sessionId`, `cwd`, `model`                                                                                                                                                                                         |
| `reset_session`       | write · serial                  | Start a replacement session for a workspace, linked by `previousSessionId`, same profile as the old active one.                  | `cwd`, `model`                                                                                                                                                                                                      |
| `set_permission_mode` | write · keyed(sessionId)        | Pass a permission mode to the runtime.                                                                                           | `sessionId`, `mode`                                                                                                                                                                                                 |
| `send_tool_result`    | write · keyed(sessionId)        | Answer an interactive tool call.                                                                                                 | `sessionId`, `toolUseId`, `content`, `isError`                                                                                                                                                                      |
| `send_notification`   | write · keyed(sessionId)        | Prompt a session with text wrapped in `<user_notification>` tags (resumes a closed session).                                     | `sessionId`, `text`                                                                                                                                                                                                 |
| `handoff`             | long_running · keyed(sessionId) | Hand this session's work to a new one (see below).                                                                               | `sessionId`, `title`, exactly one of `prompt` / `promptFile`, `targetCwd` or `worktree`, `worktreeBase`, `model`, `profile`, `origin`                                                                               |
| `get_history`         | read                            | One page of a transcript, plus usage, git status, model, agent, `claudeCode` and `idleCompaction`.                               | `sessionId`, `cwd`, `limit` (50), `before` (message index)                                                                                                                                                          |
| `get_info`            | read                            | agent-host's live session list, and one session's entry.                                                                         | `sessionId`                                                                                                                                                                                                         |
| `list_sessions`       | read                            | A workspace's chat sessions, newest created first, after an inline reconcile of its transcripts.                                 | `cwd`, `limit`, `offset`                                                                                                                                                                                            |
| `search`              | read                            | Full-text search over user messages and assistant prose (memory's index).                                                        | `query`, `cwd`, `ref` (e.g. `owner/repo#61`), `disposition[]`, `limit` (20)                                                                                                                                         |

### Queue and status

| Method           | Lane                     | Purpose                                                                                              | Notable params                                 |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `list_attention` | read                     | The ACTIVE queue: every unresolved session across all workspaces, pinned first, then newest created. | `limit` (200, max 500)                         |
| `set_status`     | write · keyed(sessionId) | Set the disposition (the human axis). Returns `changed: false` for a no-op.                          | `sessionId`, `disposition`                     |
| `snooze`         | write · keyed(sessionId) | Hide a session from the queue for N minutes, or cancel.                                              | `sessionId`, `minutes` (30, max 1440), `clear` |
| `set_pinned`     | write · keyed(sessionId) | Pin a session in the ACTIVE pane.                                                                    | `sessionId`, `pinned`                          |
| `set_title`      | write · keyed(sessionId) | Rename; `null` returns to the derived title. The reconciler never overwrites it.                     | `sessionId`, `title`                           |
| `resolve_stale`  | write · serial           | Resolve every unresolved chat session idle for N days.                                               | `olderThanDays` (5), `dryRun`                  |

### Subagents

| Method               | Lane                                  | Purpose                                                                                                      | Notable params                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn_agent`        | long_running · keyed(parentSessionId) | Spawn a child session and send its first prompt, or with `parentSessionId: "NEW"` start a top-level session. | `parentSessionId`, `prompt`, `name`, `agent`, `purpose` (`subagent`, `review`, `test`), `cwd`, `worktree`, `worktreeBase`, `model`, `systemPrompt`, `thinking`, `effort`, `sandbox`, `metadata`, `profile` (default `spawnProfile`), `origin`, `launchedBySessionId` |
| `get_subagent`       | read                                  | One child's status.                                                                                          | `subagentId`                                                                                                                                                                                                                                                         |
| `list_subagents`     | read                                  | Children, filtered.                                                                                          | `parentSessionId`, `status` (`running`, `completed`, `failed`, `interrupted`), `agent`                                                                                                                                                                               |
| `interrupt_subagent` | write · serial                        | Interrupt a child.                                                                                           | `subagentId`                                                                                                                                                                                                                                                         |

### Workspaces

| Method                    | Lane           | Purpose                                                                           | Notable params                                                                                                                                   |
| ------------------------- | -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workspaces`         | read           | Live workspaces (pinned first, then by latest transcript), or only deleted ones.  | `deleted`                                                                                                                                        |
| `get_workspace`           | read           | A workspace and its folders (root first).                                         | `id`                                                                                                                                             |
| `get_or_create_workspace` | write · serial | Find or create the workspace for a folder; restores a deleted one.                | `cwd`, `name`, `general`                                                                                                                         |
| `update_workspace`        | write · serial | Project fields and folder operations. Returns the workspace, folders and `notes`. | `id` or `cwd`, `name`, `description`, `aliases`, `githubRepo`, `detect`, `addFolder`, `removeFolder`, `setRoot`, `moveFolder {from,to}`, `merge` |
| `find_workspace`          | read           | Resolve a name/alias or `owner/repo` to exactly one workspace, else null.         | exactly one of `name`, `githubRepo`                                                                                                              |
| `set_workspace_pinned`    | write · serial | Pin a workspace.                                                                  | `id`, `pinned`                                                                                                                                   |
| `delete_workspace`        | write · serial | Soft delete (hides it and its sessions).                                          | `id` (preferred) or `cwd`                                                                                                                        |

### Pickers, refs and maintenance

| Method               | Lane               | Purpose                                                                                                      | Notable params                  |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `get_directories`    | read               | Child folders of a path (dot-folders last), for the folder browser.                                          | `path` (default `~`)            |
| `list_commands`      | read               | Skills and slash commands from `~/.claude` and `<cwd>/.claude` (project shadows global), for the `/` picker. | `cwd`                           |
| `list_files`         | read               | Files under a folder (`git ls-files` in a repo, else a walk skipping heavy dirs), for the `@` picker.        | `cwd`                           |
| `get_memory_context` | read               | Preview the memory block a new session in `cwd` would get.                                                   | `cwd`                           |
| `backfill_refs`      | write · serial     | Re-extract PR/ticket refs from full transcripts.                                                             | `days` (30), `rescan`, `dryRun` |
| `validate_refs`      | write · serial     | Check GitHub refs against the API, cache verdicts, delete refs that don't exist.                             | `limit` (50), `revalidate`      |
| `health_check`       | control · parallel | agent-host connection plus live, running and stale session counts.                                           | none                            |

## Events

| Event                     | Scope                           | When                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.<id>.<type>`     | Subscribers of `session.<id>.*` | Every agent-host stream event for the session (`content_block_delta`, `turn_stop`, `process_started`, `process_ended`, `process_died`, `modal_prompt`, `modal_prompt_cleared`, `api_error`, …). Exception: a subagent's events from its first run go only to the connection that spawned it (see Gotchas). |
| `session.<id>.git_status` | Same                            | After each turn (and on the first page of `get_history`): branch, dirty state, open PR.                                                                                                                                                                                                                    |
| `session.<id>.handoff`    | Same (the caller's own stream)  | The session handed off; payload `{ sessionId, targetSessionId, workspaceId, cwd, title }`.                                                                                                                                                                                                                 |
| `session.status_changed`  | Broadcast                       | A session's runtime status or disposition actually moved. Carries the row's live fields.                                                                                                                                                                                                                   |
| `session.activity`        | Broadcast                       | Heartbeat for a working session, at most once a second per session, forced on every transition.                                                                                                                                                                                                            |
| `session.list_changed`    | Broadcast                       | A workspace's list membership changed (`reason`: `session_created`, `disposition_changed`, `renamed`, `pinned`, `worktree_setup`, …). Carries no rows; clients refetch.                                                                                                                                    |

The extension also declares `stream.*` and `session.subagent.*`, but nothing emits them.

## Config

Keys read from `extensions.session.config`:

| Key                                                 | Default                               | Notes                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                             | none, **required**                    | The extension throws at start without it. The top-level `session.model` in `anima.json` is a different setting (agent-host's fallback) and does not satisfy this. |
| `thinking`                                          | `false`                               | Bootstrap setting for new sessions. The example config sets `true`.                                                                                               |
| `effort`                                            | `"medium"`                            | `low` \| `medium` \| `high` \| `max`.                                                                                                                             |
| `systemPrompt`                                      | `null`                                | Base system prompt for new sessions, before the start-time reminder and memory block.                                                                             |
| `spawnProfile`                                      | `"auto"`                              | Profile for `spawn_agent` when the caller names none.                                                                                                             |
| `activeQueue.excludeWorkspaces`                     | `[]`                                  | Workspace names or root folders (case-insensitive) kept out of `list_attention`. Commented example in `anima.example.json`.                                       |
| `refs.linear.prefixes` / `refs.linear.workspace`    | `[]` / unset                          | Allowed ticket prefixes (`ENG`, …) and the slug for links. No prefixes means no Linear refs. Commented example in `anima.example.json`.                           |
| `refs.github.defaultRepo` / `refs.github.minDigits` | the workspace's `origin` remote / `2` | Repo for bare `#123`, and the shortest bare number that counts. Commented example in `anima.example.json`.                                                        |

`skills.paths` and `imageProcessing`, which the example puts in this block, are read by agent-host
(`packages/agent-host/src/server.ts`), not by this extension. Outside its block the extension reads `agentHost.url`,
`gateway.token` and `agentHost.claudeRuntime` (only to decide whether `get_history` reports idle compaction).

## How it works

### Startup and the live sweep

`src/index.ts` connects to agent-host and runs `syncLiveSessions()` on the first connect, on every reconnect, and every
60 s. It lists agent-host's live sessions, subscribes to their events (agent-host only sends a session's events to a
client that created, prompted or subscribed to it), and re-derives `runtime_status` from agent-host's truth
(`reconcileInFlightStatuses` in `src/session-status-events.ts`): a row claiming `running` or `awaiting_*` with no
process becomes `stalled`, one whose process is alive but has no turn becomes `idle`, and a resting row whose turn is
in flight becomes `running`. The same sweep runs the resolved closer. Before connecting, `start()` resumes worktree
setups a restart cut off, and after the first good connect it sends prompts that were waiting on them.

Two more timers run in the background: the transcript reconciler (`src/session-reconciler.ts`, every 60 s) and the
GitHub ref validator (`src/session-ref-validity.ts`, first pass after 60 s, then every 15 min).

### The sessions table is a cache

Claude Code writes transcripts to `~/.claude/projects/<encoded folder>/<id>.jsonl`. The reconciler reads each
workspace's folders (root, active member folders, and each session's own folder), discovers transcripts, derives a
title from the first prompt, and upserts rows. `list_sessions` runs the same reconcile inline for its workspace, then
reads SQLite. A session whose transcript disappears is archived after a 5 minute grace. Sessions started outside Anima
(the raw CLI) appear this way. Every row can be rebuilt from the JSONL.

### Creating and prompting

`create_session` (`src/lifecycle/session-create.ts`) only writes a row: model, agent, the bootstrap settings in
`metadata`, the profile (write-once), `origin` and `launchedBySessionId`. It makes the session the workspace's active
one and emits `list_changed`.

`send_prompt` runs `src/lifecycle/prompt-lifecycle.ts`:

1. Resolve the session, and wait if its worktree is still being made.
2. Run in the session's stored folder, not the `cwd` the client sends: Claude Code resumes a transcript only from the
   folder that holds it, and for a worktree session the client sends the workspace root.
3. If agent-host runs the session on a different model than the one resolved for this prompt, close it first.
4. Record `lastUserMessageAt` and, the first time, a title derived from the prompt.
5. With no transcript yet, bootstrap: build the system prompt (base prompt, a local date/time reminder, the memory
   block) and ask agent-host to create the session with the stored profile.
6. Reopen the session if it was `resolved`, `archived` or `snoozed` (clears a snooze timer).
7. Set `running`, mark a subagent running again, and send. If the last assistant message was more than 3 hours ago,
   a reminder with the current time and the gap is prepended to the prompt.

Every create and prompt to agent-host carries the session's profile, looked up from its row
(`src/session-agent-bridge.ts`). A row without a profile reads as `yolo`.

### Runtime status and disposition

Each row has two independent axes (`src/session-store.ts`):

| Axis                       | Values                                                                                                                 | Written by                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `runtime_status` (machine) | `idle`, `running`, `awaiting_input`, `awaiting_approval`, `completed`, `failed`, `interrupted`, `stalled`, `api_error` | The event wiring in `src/lifecycle/session-events.ts` and the live sweep         |
| `disposition` (human)      | `open`, `needs_review`, `blocked`, `snoozed`, `resolved`, `archived`                                                   | `set_status`, `snooze`, handoff, `resolve_stale`, and the reopen on a new prompt |

There is also `status` (`active` / `archived`), which says whether the row is listed at all (transcript gone, or
`close_session`).

Event mapping: `process_started` → `running`, `process_ended` → `idle`, `turn_stop` → `completed` (and
`metadata.lastAssistantMessageAt`), `modal_prompt` → `awaiting_approval` (kind `approval`) or `awaiting_input` (and
`metadata.blockedSince`), `modal_prompt_cleared` → `running` if a turn resumed else `idle`, `api_error` with
`stalled: true` → `api_error`, `process_died` → `failed`. A dispatch that throws sets `failed`. Every write goes
through `applyRuntimeStatus` / `applyDisposition`, which emit `status_changed` only when the value moved.

### The ACTIVE queue (`list_attention`)

`listAttentionSessions` in `src/session-store.ts` returns, across all live workspaces:

- every chat session whose disposition is `open`, `needs_review`, `blocked` or `snoozed`, whatever its runtime status;
- subagent, review and test sessions only while `running`, `awaiting_*`, `api_error` or `failed`.

It skips rows whose `metadata.snoozedUntil` is still in the future and workspaces in `activeQueue.excludeWorkspaces`.
Order is pinned first, then newest created. Each row carries `waitingSince` (`blockedSince` while blocked, else
`lastAssistantMessageAt`, else `last_activity`), `origin`, `parentSessionId`, refs, a folder chip, and
`launchedBySessionId` followed forward through handoffs (`followHandoffs`), so a launched session nests under its
launcher's successor. Grouping (Background, nesting) and the banner's escalation rules are client-side; see
[chat.md](chat.md).

### Origin

`origin` is `user` or `automated`, write-once. `create_session` and `spawn_agent` default to `automated`; `handoff`
defaults to the caller's origin. The web chat sends `user`. Rows without one (older rows, sessions found on disk) read
as `user`. The CLI fills `launchedBySessionId` from `$ANIMA_SESSION_ID` for any method that accepts it, which is how a
session launched by an agent nests under that agent in the ACTIVE pane.

### Permission profiles, from the session side

A profile is chosen at creation and stored write-once in `sessions.profile`: `create_session` defaults to `yolo`,
`spawn_agent` to `spawnProfile` (`auto`), `handoff` to the caller's, `reset_session` to the previous active session's.
Built-ins are `yolo` (`bypassPermissions`) and `auto` (Claude Code's auto mode); others come from
`agentHost.sessionProfiles`. The extension does not interpret profiles: it sends the name with every create and
prompt, and agent-host (`packages/agent-host/src/profiles.ts`) resolves and enforces it.

### Subagents

`spawn_agent` (`src/lifecycle/subagent-workflow.ts`) writes a row with `purpose` `subagent` / `review` / `test`,
`parent_session_id`, the prompt and `metadata.subagentStatus: "running"`, then asks agent-host to spawn it. The folder
is `cwd`, else the parent's workspace root. The child's status lives in `metadata.subagentStatus`, not
`runtime_status`, because the live sweep rewrites the latter for any quiet pane. `src/lifecycle/subagent-events.ts`
watches the child's `turn_stop` (`completed`, or `interrupted` for an abort) and `process_died` (`failed`), and sends
the parent one `<user_notification>` prompt such as `Claude subagent <id> completed (42s).`. A follow-up prompt to the
child sets it running again and re-arms the notification.

With `parentSessionId: "NEW"` the call creates a top-level chat session instead (`cwd` required), titles it with
`name`, and sends the prompt: the way a scheduled task or script starts a session someone opens later.

### Handoff

`handoff` (`src/lifecycle/session-handoff.ts`) is what an agent calls instead of compacting. It refuses a session that
already handed off, reads the prompt (a relative `promptFile` resolves against the caller's workspace root), creates
a draft with the caller's agent, model, bootstrap settings, profile, origin and launcher, titles it, and sends the
prompt with a line naming the old session. Only after the prompt is accepted does it set `metadata.handedOffTo` and
`handedOffAt` on the caller, resolve the caller, and emit `session.<caller>.handoff`. The new row's
`previous_session_id` points back. The web chat follows the event to the new session.

### Worktrees

`create_session`, `spawn_agent` and `handoff` take `worktree: "<branch>"` (`src/worktree.ts`). The branch name is
checked, the repo is the main checkout of the folder given (for handoff, the caller's workspace root; for a child spawn
without `cwd`, the parent's root), and the worktree goes at `<repo>.worktrees/<branch>`. The bootstrap is
`extensions/session/scripts/create_worktree` unless the repo has an executable `<repo>/tmp/scripts/create_worktree`.
The script gets `<branch> [--base <ref>]` and the env `ANIMA_MAIN_REPO`, `ANIMA_WORKTREE_PATH`,
`ANIMA_SESSION_PROFILE`, `ANIMA_DEFAULT_WORKTREE_SCRIPT`; its last stdout line is the worktree path; it has 240 s. The
default script reuses or creates the branch (new branches start from origin's default branch, `--no-track`), symlinks
the main checkout's `tmp/` in, and seeds a CodeGraph index when one exists.

`spawn_agent` and `handoff` wait for the bootstrap. `create_session` answers at once
(`src/lifecycle/worktree-session.ts`): it files the future folder under the repo's workspace, creates the row there
with `metadata.worktreeSetup: { state: "running", branch, startedAt, request }`, and runs the script in the background.
On success the marker is removed (and the row follows the worktree if the script put it elsewhere); on failure it
becomes `state: "failed"` with the error. Either way `list_changed` (`worktree_setup`) fires. A prompt sent meanwhile
waits, and is kept in `metadata.pendingPrompt` so a restart can't lose it; a setup cut off by a restart runs again on
start. Nothing removes worktrees.

### Workspaces and folders

A workspace has one root (`workspaces.cwd`) and member folders in `workspace_folders` with `kind` `root`, `worktree`
or `added` (`src/workspace-folders.ts`). A folder resolves to a workspace when it is a member, when it is inside a git
repo whose top folder is a member, or when it is a git worktree of a member repo (or sits under `<member>.worktrees/`),
in which case it joins as a `worktree` member. A worktree of a repo with no workspace yet creates the repo's workspace.
Subfolders join only through git, never by path prefix. `update_workspace` adds, removes, re-roots and records moved
folders; with `merge: true` it folds another workspace into this one. Adding an unrelated folder links the root's
Claude Code auto memory into it. Deletes are soft (`deleted_at`); only `get_or_create_workspace` restores.

### Ending a session's runtime

`src/lifecycle/resolved-closer.ts` runs in the live sweep: a live session whose disposition is `resolved` or
`archived`, with no turn in flight, quiet for 5 minutes and not held by background work (agent-host's
`backgroundTasks`, honored for up to 24 h; `heldByBackgroundWork` in `@anima/shared`), is closed in agent-host. The
row is left alone, so a later prompt resumes it. agent-host's own idle reaper (`agentHost.idleStaleMs`) covers the
rest.

## Data

| Where                                                                   | What                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anima.db` → `workspaces`                                               | id, name, root `cwd`, `general`, `pinned`, `active_session_id`, project fields (`description`, `aliases`, `github_repo`), `deleted_at`                                                                                                                     |
| `anima.db` → `workspace_folders`                                        | `path`, `workspace_id`, `kind`, `inactive_at`                                                                                                                                                                                                              |
| `anima.db` → `sessions`                                                 | one row per session: `provider_session_id`, workspace, `cwd`, model, agent, purpose, parent, `status`, `runtime_status`, `disposition`, title, `metadata_json`, `previous_session_id`, `profile`, `origin`, `launched_by_session_id`, `pinned`, timestamps |
| `anima.db` → `session_refs`, `session_ref_scan`, `session_ref_validity` | PR/ticket chips, the per-session scan watermark, cached GitHub verdicts                                                                                                                                                                                    |
| `<data dir>/logs/session.log`                                           | the extension's log                                                                                                                                                                                                                                        |

The data dir is `$ANIMA_DATA_DIR`, default `~/.anima`. The tables are created by gateway migrations
(`packages/gateway/migrations/`); the extension also ensures them at open for standalone tests. `metadata_json` keys
worth knowing: `firstPrompt`, `messageCount`, `gitBranch`, `bootstrapSystemPrompt` / `Thinking` / `Effort`,
`lastUserMessageAt`, `lastAssistantMessageAt`, `blockedSince`, `snoozedUntil`, `handedOffTo`, `handedOffAt`,
`gitStatus`, `worktreeSetup`, `pendingPrompt`, `subagentStatus`.

## Gotchas

- **Params are not validated server-side.** The gateway validates only its own `gateway.*` methods, and the extension
  host validates nothing, so schema defaults and checks apply only when the CLI validates client-side. Handlers
  re-default what they need; `handoff`, `update_workspace` and `find_workspace` parse their schema explicitly. A
  WebSocket or `ctx.call` caller can send anything else.
- **`model` is required** in `extensions.session.config`, and `thinking` defaults to `false` in code although the
  example config sets `true`.
- **Reads can create things.** `list_sessions`, `send_prompt`, `switch_session` and `reset_session` call
  `getOrCreateWorkspace`, which creates a workspace for an unknown folder and `mkdir -p`s the folder if it is missing.
  `list_sessions` sits on the read lane but reconciles (writes) inline.
- **Two kinds of "snoozed".** `snooze` sets a timer and the disposition; the row leaves the queue until the timer
  passes and comes back still marked `snoozed`. Choosing "Snoozed" in a session menu calls `set_status` with no timer,
  so the row stays in the queue with a snoozed mark.
- **`resolve_stale` resolves any unresolved chat session** idle for N days, whatever its runtime status, despite the
  word "completed" in its parameter description. It is reversible with `set_status`.
- **The CLI fills `sessionId` from `$ANIMA_SESSION_ID`.** Inside an agent session, `anima session set_status
  --disposition resolved` without `--sessionId` acts on the caller itself. The CLI also fills `cwd` from the shell, so
  pass `id` to `delete_workspace`.
- **A new subagent's stream goes only to the connection that spawned it.** Its first run is bound with source
  `gateway.caller`, which the gateway delivers to that one connection; a CLI spawn's connection closes at once, and a
  tab that opens the child while it runs gets no live stream until the child's next prompt.
- **`session.search` needs the memory extension.** With memory disabled the `ctx.call` fails and so does the search.
  New sessions just start without a memory block.
- **Profiles default wide.** `create_session` defaults to `yolo` even though `origin` defaults to `automated`; an
  automated caller that wants restrictions has to pass `profile`. A session that has no row when first prompted
  bootstraps as `yolo`.
- **`switch_session` resumes by sending an empty prompt** through agent-host.

## Code map

| File                                                                                                              | Role                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                    | Extension factory, config, startup, live sweep, resolved closer wiring                               |
| `src/session-methods.ts`                                                                                          | Method definitions (schemas, lanes)                                                                  |
| `src/session-dispatch.ts`                                                                                         | Handlers for every method                                                                            |
| `src/agent-client.ts`                                                                                             | WebSocket client to agent-host (requests, events, reconnect, subscriptions)                          |
| `src/session-agent-bridge.ts`                                                                                     | The single funnel to agent-host; attaches the stored profile                                         |
| `src/session-actor-registry.ts`                                                                                   | Per-session request context (event routing) and non-streaming turn waits                             |
| `src/session-store.ts`                                                                                            | `sessions` / `session_refs` schema, upsert rules, queue query, handoff chains, stale resolve         |
| `src/session-status-events.ts`                                                                                    | Status/disposition writes and the three broadcast events; in-flight reconciliation; reopen on prompt |
| `src/session-reconciler.ts`                                                                                       | Transcript discovery into the table, every 60 s and inline on `list_sessions`                        |
| `src/claude-projects.ts`, `src/parse-session.ts`                                                                  | Transcript lookup, JSONL parsing and pagination, usage                                               |
| `src/lifecycle/prompt-lifecycle.ts`                                                                               | `send_prompt` pipeline and bootstrap                                                                 |
| `src/lifecycle/session-create.ts`                                                                                 | Draft sessions and `spawn_agent` `NEW`                                                               |
| `src/lifecycle/session-handoff.ts`                                                                                | `handoff`                                                                                            |
| `src/lifecycle/session-events.ts`                                                                                 | agent-host event → status, git status after a turn                                                   |
| `src/lifecycle/subagent-workflow.ts`, `subagent-events.ts`                                                        | Spawning, child status, parent notifications                                                         |
| `src/lifecycle/resolved-closer.ts`                                                                                | Which finished sessions to close                                                                     |
| `src/lifecycle/session-activation.ts`                                                                             | `switch_session`, `reset_session`                                                                    |
| `src/lifecycle/time-context.ts`                                                                                   | Start-time and elapsed-time reminders                                                                |
| `src/worktree.ts`, `src/lifecycle/worktree-session.ts`, `src/worktree-session-deps.ts`, `scripts/create_worktree` | Worktree creation, background setup, restart recovery, default bootstrap                             |
| `src/workspace.ts`, `src/workspace-db.ts`, `src/workspace-folders.ts`, `src/session-registry.ts`                  | Workspace CRUD, folder membership and resolution, folder operations                                  |
| `src/session-folder.ts`                                                                                           | Folder chip for sessions outside the root                                                            |
| `src/session-refs.ts`, `src/session-ref-sync.ts`, `src/session-ref-validity.ts`                                   | PR/ticket extraction, incremental sync, GitHub validation                                            |
| `src/session-search.ts`                                                                                           | `search` over memory's transcript index                                                              |
| `src/git-status.ts`, `src/lifecycle/git-status-debouncer.ts`                                                      | Branch/dirty/PR collection                                                                           |
| `src/commands-discovery.ts`, `src/file-discovery.ts`                                                              | `/` and `@` pickers                                                                                  |
