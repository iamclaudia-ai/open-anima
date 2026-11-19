# Architecture

Anima is a personal agent platform built around the **Claude Code CLI**. Instead of reimplementing an agent, it runs
the real `claude` in tmux panes and builds everything else around it: a web UI and API, persistent sessions you can
reach from anywhere, memory, a scheduler, notifications, and a daily board of the work waiting on you. This page is the
map. Each extension has its own page under [extensions/](extensions/).

## Three processes

```
                   ┌───────────────────────────────┐
                   │  Watchdog  :30085             │
                   │  spawns + health-checks (5s)  │
                   └───────┬───────────────┬───────┘
                           │               │
  browser, CLI,  ──ws──▶ ┌─▼─────────────┐ │
  desktop app            │ Gateway :30086│ │
                         │  /ws  /health │ │
                         │  /mcp  SPA    │ │
                         └──┬─────────┬──┘ │
              NDJSON stdio  │         │    │
         ┌──────────────────┘         │ ws │
   ┌─────▼─────┐ ┌──────────┐         │    │
   │ extension │ │extension │ …   ┌───▼────▼──────────────┐
   │ (process) │ │(process) │     │ Agent host :30087     │
   └───────────┘ └──────────┘     │ claude CLI in tmux,   │
     session, chat, today,        │ Agent SDK, Codex      │
     memory, scheduler, …         └───────────────────────┘
```

| Process        | Port  | Code                  | Job                                                                       |
| -------------- | ----- | --------------------- | ------------------------------------------------------------------------- |
| **Gateway**    | 30086 | `packages/gateway`    | One `Bun.serve`: WebSocket API, web UI, extension hub, MCP endpoint       |
| **Agent host** | 30087 | `packages/agent-host` | Owns every agent runtime; sessions survive gateway and extension restarts |
| **Watchdog**   | 30085 | `packages/watchdog`   | Starts the other two from `~/.anima/watchdog.json`, restarts on failure   |

Agent-host is separate from the gateway on purpose: restarting the gateway (new code, new config, a crashed extension)
never kills a running agent turn. On SIGTERM, agent-host also _drains_: it frees its port at once so a replacement can
start, and keeps streaming open responses for up to `ANIMA_DRAIN_MS` (`packages/agent-host/src/drain.ts`).

Ports come from config and can be overridden by env (`ANIMA_GATEWAY_PORT`, `ANIMA_AGENT_HOST_PORT`,
`ANIMA_WATCHDOG_PORT`); every instance setting is in `packages/shared/src/instance.ts`. The watchdog health-checks each
service on the `port` and `healthUrl` in its own `watchdog.json`, which no env var changes.

## The gateway is a pure hub

The gateway routes and fans out; it holds no business logic. Sessions, workspaces, the board, memory: all of it lives
in extensions. `packages/gateway/src/`:

| Path / file             | What                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `/ws`                   | WebSocket for every client (requires the gateway token)                         |
| `/health`               | JSON status of the gateway and each extension (token required)                  |
| `/mcp`                  | MCP server exposing the tools extensions declare in `mcpTools` (`mcp-proxy.ts`) |
| `/*`                    | The single-page web app; each extension contributes routes (`src/web/`)         |
| `index.ts`              | WebSocket handling, event routing, the `gateway.*` methods                      |
| `extensions.ts`         | Method and event routing, the `ctx.call()` hub between extensions               |
| `extension-host.ts`     | Spawns each extension as a child process and talks NDJSON over its stdio        |
| `start.ts`              | Loads `~/.anima/anima.json`, runs migrations, starts the enabled extensions     |
| `db/`, `../migrations/` | The SQLite schema (`~/.anima/anima.db`, WAL), applied in order at start         |

### The wire protocol

```jsonc
// client → gateway
{ "type": "req", "id": "a1", "method": "session.send_prompt", "params": { "sessionId": "…", "content": "hi" } }
// gateway → client: the response
{ "type": "res", "id": "a1", "ok": true, "payload": { … } }
// gateway → client: events the client subscribed to (gateway.subscribe, patterns like "session.*")
{ "type": "event", "event": "session.<id>.content_block_delta", "payload": { … } }
```

Methods are `<extension>.<name>`. Events are `<extension>.<name>`, and a session's stream is
`session.<sessionId>.<type>` so a client can follow just one. `packages/shared/src/gateway-client.ts` is the client
the web UI, the CLI and extensions all use.

### Schema-first

Every method declares a Zod `inputSchema`. `gateway.list_methods` returns them all, and the CLI builds its help,
examples and argument validation from that list, so a new method shows up in `anima <ext> --help` with no CLI change.
`docs/API-REFERENCE.md` is generated from the same schemas (`bun run docs:api`).

One known gap: the gateway validates its own `gateway.*` params, but **extension params are validated only by the
CLI**, not on the server. Schema defaults therefore don't apply to calls over WebSocket or `ctx.call`; an extension
should parse its params against its own schema in `handleMethod`.

## Extensions run out of process

Each enabled extension is its own Bun process, started by the gateway as `bun [--hot] extensions/<id>/src/index.ts
<config-json>` and wired over stdio with newline-delimited JSON. The extension's entry ends with
`runExtensionHost(factory)` from `packages/extension-host`, which handles the protocol, so the extension only
implements methods, events and lifecycle. A crashing extension takes nothing else down, and `--hot` reloads its code
without dropping the pipe.

Extensions reach each other through the gateway: `ctx.call("session.create_session", …)` from the Today extension is
routed like any client request, and `ctx.on("session.*", …)` subscribes to events. The extension list, methods and
config live in `~/.anima/anima.json` under `extensions.<id>`.

Inside an extension, requests run on **lanes** (`packages/extension-host/src/request-scheduler.ts`). A method with no
`execution` policy joins the serial `write` lane, so one slow method holds up every other call to that extension,
reads included. Give read methods `execution: { lane: "read", concurrency: "parallel" }`. This trap is real: a
board's list call once waited 28 seconds behind a background refresh until its read was moved off the write lane.
[EXTENSIONS.md](EXTENSIONS.md) covers writing one.

## The agent host

`packages/agent-host` owns every agent runtime behind one WebSocket protocol (`packages/shared/src/agent-host-protocol.ts`).
The session extension is its only client. Runtimes are a name-keyed registry built in `src/server.ts`:

| Agent    | Runtime                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `claude` | the **CLI runtime** (`agentHost.claudeRuntime: "cli"`), or the Agent SDK (`"sdk"`, also the default when unset) |
| `codex`  | the Codex CLI (`providers/codex/`)                                                                              |

Adding a runtime means a folder under `src/providers/` exposing `{ create, resume }` and one entry in that registry.
`SessionHost` (`src/session-host.ts`) tracks live sessions, buffers their events for reconnecting clients
(`event-buffer.ts`), persists state across restarts (`state.ts`, `restore.ts`), and closes idle ones.

### The CLI runtime

This is the heart of Anima: the agent is the real Claude Code, with its tools, skills, hooks, `CLAUDE.md` files and
subscription login, not a reimplementation.

1. **A tmux pane per session.** Agent-host runs `claude --session-id <id>` (or `--resume <id>`) in a pane named
   `<prefix>-claude-<id>` (prefix `anima` by default, `agentHost.tmuxPrefix`). The session id _is_ Claude Code's
   session id, so the transcript lives in `~/.claude/projects/` and `claude --resume <id>` works from any terminal.
   `src/providers/cli/session.ts`, `tmux.ts`.
2. **A streaming proxy.** Each pane's `claude` gets `ANTHROPIC_BASE_URL` pointed at a small local proxy (ports from
   `agentHost.claudeCli.basePort`). It forwards every request to `api.anthropic.com` untouched and tees the response:
   one copy streams back to the CLI, the other is parsed into events (text deltas, tool calls, stop reasons) that
   reach the web UI as they happen. `proxy.ts`. An HTTPS-proxy (MITM) mode exists as a fallback in case the base URL
   ever can't be used (`mitm-certs.ts`).
3. **The transcript tail.** Agent-host follows the session's JSONL transcript for what the stream can't tell it:
   turn ends, interrupts, API give-ups. `jsonl-tail.ts`, `api-error-nudge.ts`.
4. **Claude Code hooks.** Every launch passes `--settings` with two hooks agent-host writes
   (`hook-settings.ts`): `PermissionRequest` sends a permission prompt to agent-host and holds it open, so it can be
   answered from the web UI as a card instead of keys in the pane (`permission-requests.ts`, `bin/permission-hook.ts`);
   `Stop` records background work (shells, subagents, monitors) so a session waiting on it isn't closed as idle
   (`background-work.ts`, `bin/stop-hook.ts`).
5. **Launch details.** The persona goes in with `--append-system-prompt-file` (or replaces the prompt; see
   [PERSONAS.md](PERSONAS.md)). The session's permission **profile** becomes CLI flags (`profile-args.ts`,
   `src/profiles.ts`). The folder is pre-trusted so the trust dialog never blocks an unattended pane
   (`workspace-trust.ts`). `bin/claude-for-folder` picks a Claude account per folder when a `.claude-account` marker
   says so (`claude-account.ts`); with no marker, Claude Code's own login is used.

The SDK runtime (`providers/anthropic/`) runs turns in-process through the Claude Agent SDK instead: simpler, no tmux,
but none of the pane-based features above.

### Permission profiles

Every session runs under a profile, fixed at creation (`packages/agent-host/src/profiles.ts`):

| Profile | Mode                    | Default for                                                    |
| ------- | ----------------------- | -------------------------------------------------------------- |
| `yolo`  | bypass permissions      | `session.create_session` (sessions you start), the Today board |
| `auto`  | Claude Code's auto mode | `session.spawn_agent` (delegated subagents)                    |

Define more under `agentHost.sessionProfiles` (`permissionMode`, `tools`, `allowedTools`, `disallowedTools`, `mcp`,
`mcpServers`, `restricted`); the memory extension's summarizer runs under one (`scribe`). Profiles are how you turn
the human-in-the-loop gates from instructions into enforcement: [HUMAN-IN-THE-LOOP.md](HUMAN-IN-THE-LOOP.md).

## Sessions

The session extension (`extensions/session`) is the domain layer over agent-host: workspaces (a project folder and its
sessions), the session list, history, search, and the "needs attention" queue the UI shows. A few ideas run through
the whole system:

- **Every agent is a first-class session.** A Codex session, a delegated subagent, a scheduled job's session and the
  one you're chatting in are all the same kind of row, created through the same calls.
- **Sessions record who started them** (`origin: "user" | "automated"`), so unattended work stays in a Background
  group instead of crowding your queue.
- **Handoffs instead of compaction.** A session near the end of its context writes a brief and calls
  `anima session handoff`, which starts a linked successor in the same workspace with that brief as its first prompt.
  The web chat follows it.
- **Worktrees.** `create_session`, `spawn_agent` and `handoff` take `--worktree <branch>` and start the session in a git
  worktree of the workspace's repo.

Details: [extensions/session.md](extensions/session.md).

## Data

Paths are the defaults. The second column is what moves each one, so a second copy on the same machine (see
"Running a second copy" in [GETTING-STARTED.md](GETTING-STARTED.md)) keeps its own.

| Where (default)          | Moved by                                            | What                                                                                        |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `~/.anima/anima.json`    | `ANIMA_CONFIG`, else `$ANIMA_HOME/.anima/`          | config (JSON5); the gateway writes its token here on first start                            |
| `~/.anima/watchdog.json` | `ANIMA_WATCHDOG_CONFIG`, else `$ANIMA_HOME/.anima/` | the watchdog's service list                                                                 |
| `~/.anima/anima.db`      | `ANIMA_DATA_DIR`                                    | one SQLite database (WAL) for every extension; migrations in `packages/gateway/migrations/` |
| `~/.anima/logs/`         | `ANIMA_DATA_DIR`                                    | one log per process and extension                                                           |
| `~/.anima/agent-host/`   | `ANIMA_DATA_DIR`                                    | agent-host state, hook settings, background-work snapshots                                  |
| `~/memory/`              | `ANIMA_MEMORY_DIR`                                  | the memory extension's git repo of summaries (optional)                                     |
| `~/.claude/projects/`    | nothing (Claude Code's own)                         | Claude Code's transcripts: the source of truth for conversation history                     |
| `~/.claude.json`         | nothing (Claude Code's own)                         | agent-host marks each session folder trusted here before the first launch                   |

`ANIMA_HOME` moves the config folder (`anima.json`, `watchdog.json`, `personas/`, `hooks/`), `ANIMA_DATA_DIR` the
data folder (db, logs, state), and `ANIMA_MEMORY_DIR` the memory repo. `ANIMA_HOME` and `ANIMA_DATA_DIR` are
independent: setting `ANIMA_HOME` alone leaves the data in `~/.anima`. Write transactions use
`db.transaction(fn).immediate()`, never a deferred `BEGIN`: several processes share the database, and a deferred
transaction that reads before it writes fails at once with "database is locked".

## Clients

- **Web UI**: React, served by the gateway. Shared components and a small pushState router are in `packages/ui`; each
  extension's pages are in `extensions/<id>/src/pages` and declared in its `routes.ts`. The home page is a launcher
  with a tile for every extension route that declares an icon.
- **CLI** (`packages/cli`): schema-driven from `gateway.list_methods`. An extension can also contribute local
  commands in `src/cli.ts` for things that must run on the caller's machine.
- **Today desktop app** (`clients/desktop`): the board in its own window with a global hotkey (Tauri).

## The ideas worth taking

If you're lifting parts rather than forking the whole thing, these carry the most weight:

1. Drive the real agent CLI in a terminal multiplexer and observe it through a proxy, its transcript and its hooks.
   You get every feature the CLI ships, for free, forever.
2. Keep the agent runtime in its own process, so everything else can restart freely.
3. A hub with schema-described methods and out-of-process extensions: new features don't touch the core.
4. Sessions as durable, named, linkable things (origin, handoffs, worktrees), not throwaway chats.
5. A board that gathers what's waiting on you, with one button that starts an agent on it, and a human gate before
   anything leaves the machine.
