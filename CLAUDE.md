# Open Anima: guide for coding agents

You're working in **Open Anima**, a reference implementation of a personal AI agent platform built around the Claude
Code CLI. The person you're working with probably wants to build their own version of it: run it, understand it, then
keep, change or drop parts. Read `README.md` and `docs/ARCHITECTURE.md` before making structural changes.

## Working with your human

- **Ask before anything leaves the machine or becomes permanent**: pushing, opening or updating a PR, approving or
  merging, posting a review or comment or message, sending mail, deploying or releasing, deleting what can't be put
  back. Prepare it fully (the commits, the draft, the exact command), say what you're about to do and why, and wait for
  an explicit go. A go covers what was approved, nothing more. Your human may loosen this for specific steps; follow
  what they've written down, not what seems efficient. See `docs/HUMAN-IN-THE-LOOP.md`.
- **Verify before you claim.** Don't say tests pass, a page loads or a method exists unless you ran or read it.
  The docs here were checked against the code; keep them that way when you change behavior.
- **Ideas mid-task become notes or issues, not detours.** Finish what you were asked; list follow-ups at the end.
- **Long work:** keep a running `tmp/<task>/NOTES.md` (plan, done, open, hard-won facts) and, near the end of your
  context, hand off with `anima session handoff --title "…" --promptFile tmp/<task>/HANDOFF.md` instead of compacting.

## Commands

```bash
bun install                 # Bun only: never npm, pnpm or yarn
bun run typecheck           # tsgo (TypeScript native preview)
bun run lint                # oxlint (formatting: oxfmt)
bun run test                # every test; bun test ./<path> for one area
bun run docs:api            # regenerate docs/API-REFERENCE.md after changing any method schema
bun run watchdog            # run the system (reads ~/.anima/watchdog.json)
bun run cli <ext> <method>  # the anima CLI from the repo; `--help` on anything
```

Husky hooks run typecheck and lint-staged on commit, and typecheck, unit tests and the API reference check on push.

## Layout

```
packages/
  gateway/         the hub: Bun.serve on one port (/ws, /health, /mcp, the SPA), extension processes, migrations/
  agent-host/      agent runtimes (src/providers/{cli,anthropic,codex}), profiles.ts, persona.ts, session-host.ts
  watchdog/        supervisor for gateway + agent-host
  extension-host/  runExtensionHost(), createStandardExtension(), request-scheduler.ts (lanes)
  cli/             schema-driven `anima` CLI
  shared/          config, protocol, types, instance.ts (ports, data dirs, tmux prefix)
  shell-parser/    shell parsing for permission policies
  ui/              React components, chat UI, router, gateway hooks
extensions/<id>/src/  index.ts (server), routes.ts + pages/ (web), cli.ts (rare local commands)
clients/desktop/      Today desktop app (Tauri)
personas/             shipped personas (lumen.md)
docs/                 ARCHITECTURE, GETTING-STARTED, EXTENSIONS, PERSONAS, HUMAN-IN-THE-LOOP, extensions/*.md
```

## Rules of the codebase

- **The gateway has no business logic.** New features are extensions (`docs/EXTENSIONS.md`).
- **Schema-first.** Every method declares a Zod `inputSchema`. The server doesn't validate extension params, so
  parse them in the handler.
- **Declare `execution` on every extension method.** Without it a method joins the serial `write` lane and every
  read waits behind the slowest write. Reads: `{ lane: "read", concurrency: "parallel" }`; health:
  `{ lane: "control", concurrency: "parallel" }`.
- **One SQLite database** (`~/.anima/anima.db`, WAL), shared by several processes. Schema changes are numbered
  migrations in `packages/gateway/migrations/`. Write transactions use `db.transaction(fn).immediate()`.
- **No paths at import time.** Resolve `animaDataDir()`, `animaConfigHome()`, the memory dir and ports when used, so
  tests and second instances can redirect them (`packages/shared/src/instance.ts`). Tests must never touch the real
  `~/.anima`, `~/.claude` or `~/memory`: `scripts/test-preload.ts` drops the shell's `ANIMA_*` variables and points
  the config, data and memory folders at temporary ones, and code that touches `~/.claude` takes its home folder as a
  parameter so tests can pass a temporary one (Bun's `os.homedir()` ignores `HOME` changes made at runtime).
- **Strict TypeScript**, no `any`, files around 500 lines or less, Bun APIs where they exist.
- **Clean breaks.** This is single-user software: when you change a shape, update every caller and delete the old
  path rather than keeping compatibility shims, unless asked.
- **Scratch files go in `tmp/`** (gitignored), never the repo root.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:` …).

## Things that surprise people

- **Agent sessions are real Claude Code processes in tmux panes** (`<prefix>-claude-<id>`). Their transcripts live
  in `~/.claude/projects/`, and the user's own `~/.claude/CLAUDE.md` and settings load in them.
- **Restarting** the gateway doesn't affect running agent turns; restarting agent-host drains them first. After
  editing `~/.anima/anima.json`, restart the gateway: extensions read their config at gateway start.
- **A second instance** on one machine needs its own ports (in `watchdog.json` too), tmux prefix, folders, CLI wrapper
  and LaunchAgent label, or it will reach the first one's services or adopt and reap its panes. The checklist is
  "Running a second copy" in `docs/GETTING-STARTED.md`.
- **The CLI's `send_prompt`** can stop printing a slow reply early; the full reply is in `session get_history`.
- **The persona** is appended to Claude Code's system prompt by default (`agentHost.personaMode`), and is read when
  agent-host starts.

## Running it to test a change

Use the user's running instance only if they say so. For an isolated copy, follow "Running a second copy" in
`docs/GETTING-STARTED.md`: an `env.sh` with other ports (`ANIMA_GATEWAY_PORT`, `ANIMA_AGENT_HOST_PORT`,
`ANIMA_WATCHDOG_PORT`, plus every port in its `watchdog.json`), its own `ANIMA_HOME` / `ANIMA_DATA_DIR` /
`ANIMA_MEMORY_DIR`, `ANIMA_TMUX_PREFIX` and `ANIMA_WATCHDOG_LABEL`, and its own `anima` wrapper. Check pages with a
headless browser, not on the user's screen.
