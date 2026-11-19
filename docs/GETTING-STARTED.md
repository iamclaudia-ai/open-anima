# Getting started

This gets Open Anima running on your machine: the gateway, the agent host, the web chat, and the Today board. Plan on
twenty minutes, most of it config.

Open Anima is developed and run on **macOS**. The core (Bun, tmux, the Claude Code CLI) has nothing Mac-specific, but
Linux is untested, and a few extras are Mac-only (the `macos` notification delivery, the launchd service, the Today
desktop app).

## 1. What you need

| Tool                               | Why                                                     | Check            |
| ---------------------------------- | ------------------------------------------------------- | ---------------- |
| [Bun](https://bun.sh) 1.4 or later | runs everything                                         | `bun --version`  |
| tmux                               | the CLI runtime runs each Claude Code session in a pane | `tmux -V`        |
| Claude Code (native), logged in    | the agent itself                                        | `claude doctor`  |
| git                                | worktrees, the memory repo                              | `git --version`  |
| `gh` logged in, `jq` (for Today)   | the board's GitHub sources                              | `gh auth status` |

A Linear API key is optional (Today can show your assigned issues). The Today desktop app (step 9) also needs Rust and
Tauri's macOS prerequisites; nothing else does.

**The watchdog updates Claude Code.** Every time it starts (step 4), the watchdog runs `claude update` on the `claude`
it finds on your PATH, so sessions get the newest CLI (`packages/watchdog/src/claude-update.ts`). If you pin your
Claude Code version, start the watchdog with `ANIMA_SKIP_CLAUDE_UPDATE=true` in its environment.

**Use the native install.** `claude update` only updates Claude Code's native install (`~/.local/bin/claude`). With
a Homebrew or npm install, the watchdog logs `Claude CLI update check failed` and starts anyway, so the CLI quietly
falls behind. Old versions break Anima in ways that are hard to trace: one tester on 2.1.267 found that sessions
exited right after launch (that version rejects `--append-system-prompt` together with `--append-system-prompt-file`)
and that prompts failed with "prompt too long" (that version turns off MCP tool search behind Anima's proxy, so every
tool loads up front). `claude doctor` shows the install method (`Running: native (…)`). To switch, run
`claude install latest`, then uninstall the old copy (`brew uninstall --cask claude-code` or
`npm uninstall -g @anthropic-ai/claude-code`), so your shell and Anima run the same `claude`.

## 2. Install

```bash
git clone <your fork of open-anima> ~/open-anima
cd ~/open-anima
bun install
bun run typecheck
bun run test          # optional
```

`bun install` may end with a "Blocked N postinstalls" line (for `tree-sitter-bash`'s native build). That's expected:
the shell parser loads the WebAssembly grammar the package ships (`packages/shell-parser/src/parse.ts`), so nothing
needs the native build. Leave them blocked; there's no need for `bun pm trust`.

`bun run test` runs `bun test` on `packages/`, `extensions/`, `scripts/` and `hooks/`. The run is hermetic: a preload
(`scripts/test-preload.ts`) drops any `ANIMA_*` variables your shell has and gives the tests a temporary config and
data folder, so it works before you've written a config (step 3) and never touches a running Anima. A green run is
about 1,380 tests with `0 fail`, in under a minute.

## 3. Configure

Anima reads `~/.anima/anima.json` (JSON5: comments and trailing commas are fine).

```bash
mkdir -p ~/.anima
cp anima.example.json ~/.anima/anima.json
```

Open it and look at least at these:

- **`extensions.today.config.projects`**: the sample project points at `/path/to/app` and `acme/app`. Change `name`,
  `cwd` and `github.repos` to a real project and repo of yours, or set `"projects": []` for now.
- **`extensions.notify.config.delivery`**: the default `{ "type": "log" }` only writes to a log file, so nothing
  reaches you. On a Mac, `{ "type": "macos" }` shows a notification. See [extensions/notify.md](extensions/notify.md).
- **`agentHost.persona`**: `"lumen"` is the shipped general-purpose persona. See [PERSONAS.md](PERSONAS.md).
- **`agentHost.claudeRuntime`**: the example sets `"cli"`, which runs the real `claude` in tmux panes and is what this
  guide describes. Left out, it defaults to `"sdk"` (the Agent SDK runtime, without the pane features), so keep it if
  you write a smaller config of your own.

Leave `gateway.token` out: the gateway generates one on first start and writes it into this file (it inserts one line
and keeps the rest, comments included). If you keep your config in git, expect that change. The memory extension
starts disabled; turn it on later (step 9).

## 4. Start it

Two long-lived processes do the work: **agent-host** (port 30087, owns the Claude Code sessions) and the **gateway**
(port 30086, the web UI, WebSocket API and extensions). The **watchdog** (port 30085) starts both, health-checks them
every 5 seconds and restarts one that fails. Its config is strict JSON (no comments):

```bash
cp watchdog.example.json ~/.anima/watchdog.json
# set both "cwd" values to this checkout, e.g. "~/open-anima" (~ expands; an absolute path works too)
bun run watchdog
```

You should see both services come up. In another terminal:

```bash
bun run cli watchdog status
#  ● Agent Host healthy ...
#  ● Gateway    healthy ...
```

Without the watchdog, start the two by hand, agent-host first:

```bash
bun run packages/agent-host/src/index.ts     # terminal 1
bun run packages/gateway/src/start.ts        # terminal 2
```

Logs go to `~/.anima/logs/` (`gateway.log`, `agent-host.log`, one `<extension>.log` each, `watchdog.log`).

## 5. Put the `anima` CLI on your PATH

`bun run cli …` works from the repo, but sessions need a plain `anima` command: the Today board's prompts tell the
agent to run `anima today ask`, `anima session set_status` and friends from whatever folder it's working in.

```bash
mkdir -p ~/.local/bin                     # or any folder on your PATH
printf '#!/bin/sh\nexec bun run "%s/packages/cli/src/index.ts" "$@"\n' "$PWD" > ~/.local/bin/anima
chmod +x ~/.local/bin/anima
anima methods                             # from any folder: every method the gateway offers
```

The CLI discovers every method from the gateway: `anima methods [extension]`, `anima <extension> --help`,
`anima <extension> <method> --help`.

## 6. Open the web UI

Go to <http://127.0.0.1:30086>. The first visit asks for the gateway token:

```bash
anima token show
```

Paste it once; the browser keeps it (`localStorage` key `anima_token`). Adding `?token=` to the URL does **not**
log you in. Settings → Log out clears it.

The home page is a launcher with one tile per extension page: Today, Control, Chat, Scheduler (and Memory once it's
enabled).

**Control** (`/control`) shows each extension's health. The Skills card reads your own `~/.claude/skills`, so on a
fresh install it can say **Degraded** because of problems in that folder (a broken symlink, a folder without a
`SKILL.md`, two skills with one name). `anima skills list_skills` lists them under `problems`; see
[extensions/skills.md](extensions/skills.md).

## 7. Your first session

Open **Chat** and choose **New workspace**. The dialog is a folder browser that starts at `~/Projects`: click a folder
to go into it, ↑ to go up (as far as your home folder), or type a **New Folder Name** to create one inside the folder
shown. **Create & Start Session** registers the folder as a workspace and opens a new session in it. (No `~/Projects`?
The list is empty; press ↑.) For a folder outside your home folder, create the workspace from a terminal instead,
`anima session get_or_create_workspace --cwd /path/to/project`, then reload the chat page to see it.

Type hello and send it with **⌘↵** (or the send button); Enter adds a new line. The agent introduces itself as Lumen
(or your persona). Behind the scenes:

1. The session extension asks agent-host to create a session in that folder.
2. Agent-host marks the folder trusted in Claude Code's `~/.claude.json`
   (`projects[<folder>].hasTrustDialogAccepted`), because nobody is at the pane to answer Claude Code's "do you trust
   this folder?" dialog. Creating a session in a folder counts as trusting it
   (`packages/agent-host/src/providers/cli/workspace-trust.ts`).
3. It starts the real `claude` CLI in a tmux pane named `anima-claude-<id>`, with the persona appended to Claude Code's
   system prompt and a local proxy that streams the model's output back to the web page.
4. The conversation is Claude Code's own transcript in `~/.claude/projects/`, so `claude --resume <id>` in a terminal
   picks up the same session.

Watch the pane if you're curious: `tmux attach -t anima-claude-<id>` (the session menu in the chat shows the exact
command). Detach with `Ctrl-b d`.

Prefer the web chat for your first prompts. `anima session send_prompt` works, but it stops printing shortly after the
reply goes quiet, so a slow first reply (a cold start) can come back as just its first few words. The full reply is
always in the session: `anima session get_history --sessionId <id>`.

Your own `~/.claude/CLAUDE.md` and the project's `CLAUDE.md` load in these sessions too, the same as in a terminal.

## 8. The Today board

Open **Today** (`/today`). With a real project in `extensions.today.config.projects` it collects:

- PRs waiting for your review (`github.reviews: true`)
- your own open PRs and where they stand (`github.mine: true`)
- merged PRs production doesn't have yet (`github.deploys`, optional)
- Linear issues assigned to you (optional: a key plus a `linear` block on the project)
- promises: things you said you'd do (`anima today add_item --project <name> --title "…"`, or a promise ledger file)

Each item has a launch button that starts a session prompted to do that item's work, in its own git worktree if the
project has `worktree` set. Those sessions stop and ask you on the board before they push, merge, post or deploy:
[HUMAN-IN-THE-LOOP.md](HUMAN-IN-THE-LOOP.md) explains the gates, and [extensions/today.md](extensions/today.md) the
whole board.

After editing the config, restart the gateway (`anima watchdog restart gateway`): extensions read their config when
the gateway starts.

The board's morning note and top picks come from a scheduled agent session, not from the board itself. The companion
**open-skills** collection (<https://github.com/iamclaudia-ai/open-skills>) has the sweep skill
(`running-today-sweeps`) and example scheduler tasks.

## 9. Optional pieces

**Memory.** Ingests your Claude Code transcripts and has a summarizer session (the Scribe) write them up as memories
in a git repo. Set it up:

```bash
mkdir -p ~/memory && git -C ~/memory init
```

then set `extensions.memory.enabled` to `true` and restart the gateway. It only summarizes when asked
(`anima memory process`) unless you set `autoProcess: true`. Read [extensions/memory.md](extensions/memory.md) first: it
reads every transcript under `~/.claude/projects`, so use `exclude` for anything you don't want summarized.

**Skills.** Claude Code skills are folders with a `SKILL.md`. Link a collection (such as
[open-skills](https://github.com/iamclaudia-ai/open-skills)) into `~/.claude/skills` so every session can use it. See
[extensions/skills.md](extensions/skills.md).

**Hooks.** Small event handlers in `~/.anima/hooks`. Try the bundled example: [extensions/hooks.md](extensions/hooks.md).

**Notifications.** `anima notify send --message "hello"` tests your delivery.

**Run at login (macOS).** `bun run watchdog:deploy` compiles the watchdog to `~/.anima/bin/watchdog`. Then
`anima watchdog install` writes a LaunchAgent (`~/Library/LaunchAgents/com.anima.watchdog.plist`) that runs it, or
`bun run watchdog` from this checkout if you skipped the deploy, and loads it; `anima watchdog uninstall` removes it.
`scripts/com.anima.watchdog.plist` shows what the file looks like.

**The Today desktop app (macOS).** The board in its own window with a global hotkey (`clients/desktop`). Building it
needs Rust (`cargo`, from [rustup](https://rustup.rs)) and Tauri's macOS prerequisites (the Xcode Command Line Tools;
see <https://v2.tauri.app/start/prerequisites/>). Then `cd clients/desktop && bun run install-app`. Details in
[clients/desktop/README.md](../clients/desktop/README.md).

## 10. When something's off

| Symptom                                    | Look at                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| a service won't stay up                    | `anima watchdog status`, `~/.anima/logs/watchdog.log`, the service's log |
| the web page keeps asking for the token    | `anima token show`, paste it again                                       |
| a session never answers                    | `~/.anima/logs/agent-host.log`; `tmux attach -t anima-claude-<id>`       |
| an extension is missing from the home page | `/control` (health of each extension), `~/.anima/logs/<extension>.log`   |
| Today shows a source error                 | `gh auth status`, `jq --version`, the project's `cwd` and repos          |
| the agent quotes rules you didn't write    | your `~/.claude/CLAUDE.md` and the project's `CLAUDE.md` load too        |

### Running a second copy

A second Anima next to another one on the same machine (to try a change, say) needs its own ports, tmux prefix,
folders, CLI and LaunchAgent. Every setting and its environment override is listed in
`packages/shared/src/instance.ts`. The example below uses `~/anima-2` for everything, ports 34085-34087 and proxy
ports from 35000; any values work as long as none overlap the first copy's.

**1. An `env.sh` to source** in every shell that starts or talks to the second copy:

```bash
# ~/anima-2/env.sh
A="$HOME/anima-2"
export ANIMA_HOME="$A"                    # config: $A/.anima/anima.json, watchdog.json, personas/, hooks/
export ANIMA_DATA_DIR="$A/data"           # database, logs, agent-host state (not moved by ANIMA_HOME)
export ANIMA_MEMORY_DIR="$A/memory"       # the memory repo, if you enable memory
export ANIMA_WATCHDOG_PORT=34085
export ANIMA_GATEWAY_PORT=34086
export ANIMA_AGENT_HOST_PORT=34087
export ANIMA_TMUX_PREFIX=anima2           # not "anima-…" (see below)
export ANIMA_WATCHDOG_LABEL=com.anima.watchdog.anima2
export ANIMA_SKIP_CLAUDE_UPDATE=true      # the claude binary is shared: let the first copy update it
export PATH="$A/bin:$PATH"                # this copy's `anima`
# Started from inside another Anima's session? Drop what it exported, or it points back there.
unset ANIMA_CONFIG ANIMA_GATEWAY_URL ANIMA_WATCHDOG_URL ANIMA_WATCHDOG_CONFIG \
  ANIMA_SESSION_ID ANIMA_PERMISSION_HOOK_URL ANIMA_PERMISSION_HOOK_TOKEN ANIMA_DRAIN_MS
```

**2. Config.** From the second copy's checkout:

```bash
. ~/anima-2/env.sh
mkdir -p "$ANIMA_HOME/.anima" "$ANIMA_DATA_DIR" "$ANIMA_HOME/bin"
cp anima.example.json "$ANIMA_HOME/.anima/anima.json"
cp watchdog.example.json "$ANIMA_HOME/.anima/watchdog.json"
```

Then check each of these:

- [ ] **`anima.json`**: `agentHost.claudeCli.basePort` to `35000`. It has no env override, and each CLI session's
      proxy takes a port from `basePort` to `basePort + 999`. Setting `gateway.port`, `agentHost.port` and
      `agentHost.tmuxPrefix` to the env.sh values too keeps the file right for anything started without env.sh.
- [ ] **The tmux prefix doesn't start with `anima-`.** Each agent-host adopts (`packages/agent-host/src/restore.ts`)
      and reaps (`packages/agent-host/src/tmux-reaper.ts`) every pane whose name starts with `<its prefix>-claude-` or
      `<its prefix>-wrapper-`, and tmux has one server per user, so the two copies see each other's panes. The first
      copy (prefix `anima`, the default) treats any `anima-claude-…` or `anima-wrapper-…` pane as its own: with a
      prefix such as `anima-claude` or `anima-wrapper-2`, the second copy's panes would be adopted or killed by it. A
      prefix that isn't `anima-…` can't collide, and keeps the two apart in `tmux ls`.
- [ ] **`watchdog.json`: every port.** The top-level `port` (34085), and each service's `port` and the port in its
      `healthUrl` (34087 for agent-host, 34086 for the gateway); also both `cwd` values. `ANIMA_WATCHDOG_PORT` moves
      only the watchdog's own port: the services' ports and health URLs come from this file alone, and with the
      example's values this watchdog would health-check the first copy's services.
- [ ] **`watchdog.json` stays at `$ANIMA_HOME/.anima/watchdog.json`**, where the watchdog and the CLI look for it, or
      set `ANIMA_WATCHDOG_CONFIG` to its path in env.sh.
- [ ] **Memory (if you enable it):** the `scribe` profile's path rules in `anima.json` name `~/memory` and `~/.anima`
      literally. Change them to this copy's memory and data folders.

**3. Its own CLI.** Write the wrapper from step 5 to `~/anima-2/bin/anima` (env.sh puts that folder first on PATH),
pointing at the second copy's checkout (its own clone, `~/open-anima-2` below, or the same one). Don't write it over
`~/.local/bin/anima`: that's the first copy's. Sessions need no wrapper of their own: agent-host passes its `ANIMA_*`
variables into every session it starts, so the `anima` a session finds reaches the copy that started it.

**4. Start it.** From a shell that sourced env.sh: `bun run watchdog`. The watchdog hands its own `ANIMA_*` variables
to the services it starts. In tmux, put the env in the command: a new tmux session takes its environment from the tmux
server (started by whoever ran tmux first), not from the shell you typed in.

```bash
tmux new-session -d -s anima2-watchdog '. ~/anima-2/env.sh && cd ~/open-anima-2 && bun run watchdog'
```

**5. Run at login.** Run `bun run watchdog:deploy` and `anima watchdog install` from a shell that sourced env.sh
(the deploy puts the binary in this copy's data folder). `install`, `uninstall` and `reload` act on the LaunchAgent
named by `ANIMA_WATCHDOG_LABEL`, default `com.anima.watchdog`, which belongs to the first copy. With `ANIMA_*`
variables set and no label of its own, the CLI refuses rather than touch it. `install` writes this shell's instance
variables into the LaunchAgent.

**6. The desktop app isn't per copy.** An installed Today.app reads `~/.anima/desktop.json`, so it shows the first
copy's board. Don't run `bun run install-app` for this copy: it replaces `/Applications/Today.app` when that is the
same app (same bundle id), and refuses when it is another one. To see this copy's board in the desktop app, run
`bun run dev` in `clients/desktop` from a shell that sourced env.sh, after putting `"gatewayPort": 34086` (and a
different `hotkey`) in `$ANIMA_DATA_DIR/desktop.json`.

**Shared whatever you set:** `~/.claude` (transcripts, skills, settings), `~/.claude.json`, the `claude` binary and
the tmux server. A second copy's memory extension, if enabled, ingests every transcript under `~/.claude/projects`,
the first copy's sessions included.

Next: [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit, and [EXTENSIONS.md](EXTENSIONS.md) to build your own.
