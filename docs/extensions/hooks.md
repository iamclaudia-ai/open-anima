# Hooks extension

The hooks extension loads small TypeScript or JavaScript files ("hooks") from disk, subscribes them to gateway
events, and calls their handler when a matching event goes by. A hook can do anything a Bun script can (run `git`,
read files) and publish a result with `ctx.emit`, which the extension sends out as `hook.<hookId>.<event>`. The web
chat subscribes to `hook.*` and keeps the latest payload per hook id. Hooks are for lightweight, local reactions to events without writing a whole extension. The extension makes no
`ctx.call` requests and depends on no other extension; it only listens (`ctx.on("*")`) and emits.

## Methods

Both methods run on the default serial write lane (neither declares `execution`).

| Method               | Purpose                                                   | Params |
| -------------------- | --------------------------------------------------------- | ------ |
| `hooks.list`         | Loaded hooks: `{ hooks: [{ id, events, description }] }`  | none   |
| `hooks.health_check` | Health card for `/control`: count and ids of loaded hooks | none   |

Events emitted: `hook.<hookId>.<event>` (declared as `hook.*`).

## Web pages

None. The chat keeps the latest `hook.*` payload per hook id (`useChatGateway`); its status bar
(`packages/ui/src/components/StatusBar.tsx`) only renders a `git-status` payload shape, a leftover from an older hook.
The chat's git line itself comes from the session extension's `session.<id>.git_status` event, not from a hook.

## Config

`extensions.hooks.config` in `~/.anima/anima.json`:

| Key                 | Default | Meaning                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------ |
| `extraDirs`         | `[]`    | More global hook folders to scan, after the default one. Absolute paths. |
| `workspaceRescanMs` | `10000` | Minimum time before the same workspace's hook folder is scanned again.   |

`anima.example.json` has `extraDirs` but not `workspaceRescanMs` (the default is fine for most setups).

## Writing a hook

A hook is one `.ts` or `.js` file whose default export is a `HookDefinition` (`packages/shared/src/types.ts`). The
file name, minus the extension, is the hook id.

```ts
import type { HookDefinition } from "@anima/shared";

export default {
  event: ["session.*"], // one pattern or a list
  description: "What it does",
  async handler(ctx, payload) {
    // ctx.workspace: { cwd } | null, ctx.sessionId: string | null, ctx.log
    ctx.emit("result", { anything: true }); // goes out as hook.<file-name>.result
  },
} satisfies HookDefinition;
```

Event patterns: an exact event name, a prefix wildcard ending in `.*` (`session.*` matches every event starting with
`session.`), or `*` for everything. A wildcard only works at the end: `session.*.message_stop` matches nothing. A file
without a `handler` or `event` is skipped with a warning.

Hook folders:

- **Global:** `$ANIMA_HOME/.anima/hooks` (default `~/.anima/hooks`, the folder next to `anima.json`, not the data
  folder), then each folder in `extraDirs`. Scanned once at start.
- **Workspace:** `<cwd>/.anima/hooks`, where `cwd` comes from the event being dispatched. A workspace hook with the
  same id as a global one replaces it.

### Trying the bundled example

The repo ships `hooks/turn-summary.ts`. It listens to `session.status_changed` (a fixed event name whose payload
carries the session's folder) and, when a session's runtime status moves to `completed`, emits
`hook.turn-summary.turn_completed` with a one-line summary such as "Fix the login redirect finished a turn (in
/work/app)". Symlink it into the global folder and restart the extension:

```bash
mkdir -p ~/.anima/hooks
ln -s "$PWD/hooks/turn-summary.ts" ~/.anima/hooks/turn-summary.ts
bun run cli gateway restart_extension --extension hooks
bun run cli hooks list    # shows turn-summary
```

Its log line lands in `<data dir>/logs/hooks.log` after each finished turn.

## How it works

All of it is in `src/index.ts`. On `start()` the extension scans the global folders, `import()`s every `.ts`/`.js`
file, normalizes each hook's patterns (deduplicated; exact names first, then `prefix.*`, then `*`) and subscribes once
to `*`. One subscription means a hook whose patterns overlap still runs once per event.

For each event, `dispatchEvent` first looks for a workspace folder in the payload (`payload.cwd`, else
`payload.workspace.cwd`). If it finds one, it records it as the current workspace and loads `<cwd>/.anima/hooks`
(skipped when the same folder was scanned less than `workspaceRescanMs` ago). If the payload has none, it clears the
current workspace and drops the workspace hooks. Then every hook with a matching pattern runs in turn; an error is
logged and does not stop the others. Each handler gets a fresh `HookContext` whose `emit` prefixes
`hook.<hookId>.`.

The extension stores nothing: no tables, no files. Its log is `<data dir>/logs/hooks.log`.

## Gotchas

- **Per-session events can't be singled out.** Session stream events are named `session.<sessionId>.<type>` (built in
  `extensions/session/src/agent-client.ts`), and a pattern can only end in `.*`. To react to one kind of stream event,
  subscribe to `session.*` and check the payload's `type`. For turn ends, `session.status_changed` is easier: it has a
  fixed name and carries `cwd` (that's what the example hook uses).
- **`ctx.workspace` is only set for events that carry a cwd.** Streaming session events (`message_stop`,
  `content_block_delta`, ...) have no `cwd` in their payload, and an event without one clears the current workspace
  before the handlers run. A hook that needs the folder on such events gets `null`. `HookContext` has no `ctx.call`, so
  it can't ask the session extension either; it has to work from the payload (which has `sessionId`) or from disk.
- **Workspace state is one slot for the whole extension.** The current workspace and session id are whatever the last
  event carried, across every session and client. Events are dispatched fire-and-forget (`void dispatchEvent(...)`),
  so two interleaved events can race.
- **Edits to a hook file are not picked up by a rescan.** Rescans `import()` the same path, and Bun returns the cached
  module. Restart the extension (`bun run cli gateway restart_extension --extension hooks`) after editing. New files in
  a workspace folder are picked up on the next rescan; new global files only on restart.
- **`extraDirs` entries are not `~`-expanded.** They go straight to `existsSync`; use absolute paths.
- **Hook output in the UI is global.** `useChatGateway` keeps one payload per hook id, regardless of which session or
  workspace produced it.
- **Every handler runs inside the hooks extension's process.** A slow handler delays the hooks after it for that
  event; a handler that throws is only logged.

## Code map

- `src/index.ts`: loading, pattern matching, workspace scanning, dispatch, the two methods.
- `src/index.test.ts`: loading, precedence, wildcard ordering and rescan behavior.
- `../../hooks/turn-summary.ts` (+ `.test.ts`): the example hook.
- `packages/shared/src/types.ts`: `HookDefinition`, `HookContext`.
- `packages/ui/src/hooks/useChatGateway.ts`, `packages/ui/src/components/StatusBar.tsx`: where hook output is shown.
