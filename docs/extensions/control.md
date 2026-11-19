# Control extension

The control extension is the operator's view of a running instance: a health dashboard at `/control` and a live log
viewer at `/logs`. The dashboard has no knowledge of other extensions built in. It asks the gateway which extensions
are loaded (`gateway.list_extensions`), calls each one's `*.health_check` method, and renders whatever comes back in
the shared `HealthCheckResponse` shape. So any extension gets a card on the dashboard just by exposing a
`<id>.health_check` method. On the server side, control only lists and reads log files; it makes no `ctx.call`
requests, emits no events and listens to none.

## Methods

All three run on the default serial write lane (none declares `execution`).

| Method                 | Purpose                                                                               | Params                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `control.log_list`     | Log files in `<data dir>/logs`: `{ files: [{ name, size, modified }] }`, newest first | none                                                                          |
| `control.log_tail`     | Read a log file: `{ lines, offset, fileSize }`                                        | `file` (required), `lines` (1-1000, default 100), `offset` (bytes, default 0) |
| `control.health_check` | Its own health card                                                                   | none                                                                          |

`log_tail` with `offset: 0` returns the last `lines` lines. With an `offset` it returns every line after that point
(ignoring `lines`), and the returned `offset` is the file size to pass next time. If `offset` is at or past the end of
the file, it returns no lines and the current size, which is also how a rotated (shrunk) file recovers.

## Web pages

| Route      | Page                               | What it shows                                                                                                         |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/control` | `src/pages/MissionControlPage.tsx` | One card per extension with a `health_check`: status dot, metrics, items, action buttons. Polls every 5 s.            |
| `/logs`    | `src/pages/LogViewerPage.tsx`      | Pick a log file, follow it every 2 s, filter by `INFO`/`WARN`/`ERROR`, pause, auto-scroll. Keeps the last 2000 lines. |

The launcher tile ("Control", Activity icon, amber) links to `/control`.

## Config

None. `extensions.control.config` is `{}` in `anima.example.json` and nothing reads it.

## How it works

**Dashboard.** `MissionControlPage` calls `gateway.list_extensions`, keeps the extensions with a method ending in
`.health_check`, and calls them all in parallel. Each response is normalized (`normalizeHealthResponse`): a missing
`label` falls back to the extension name, a missing `ok` is derived from `status !== "error"`, and a response without
`metrics` gets fallback metrics from `message`, `uptime` and a flat `stats` object. A failed call shows as an error
card.

Health responses can carry `actions` (`{ method, label, confirm?, params, scope? }`) and `items` (rows with `id`,
`label`, `status`, `details`). An action button calls its `method` on the gateway. Each param is filled from the row
(`source: "item.id"`) or asked for with a browser prompt (`source: "input"`); `confirm` shows a confirm dialog first.
The dashboard refreshes half a second after an action. The types live in `packages/shared/src/types.ts`
(`HealthCheckResponse`, `HealthAction`, `ActionParam`, `HealthItem`).

**Logs.** Every extension host writes `<data dir>/logs/<extension id>.log` (the data dir is `$ANIMA_DATA_DIR`, default
`~/.anima`), next to `gateway.log`, `agent-host.log` and `extension-host.log`. `log_list` returns files ending in `.log`
or `.jsonl`. `log_tail` takes the base name of `file` only (so `../` can't escape the folder) and rejects anything that
doesn't end in `.log` or `.jsonl`. The viewer prefers `gateway.log` or `session.log` on first load, else the most
recently modified file. Level filtering and coloring are plain substring checks for `[ERROR]`, `[WARN]` and `[INFO]`,
which is the format `createLogger` (`packages/shared/src/logger.ts`) writes.

The extension stores nothing of its own.

## Gotchas

- **`offset` is in bytes, but the slice is in characters.** `log_tail` returns `stat.size` (bytes) as the next offset,
  then later does `content.slice(offset)` on the decoded string. Once a log contains any multi-byte UTF-8 character
  (an emoji, an accented name), the two drift apart and the viewer skips or repeats text on every poll.
- **`log_tail` reads the whole file on every call.** It's fine for logs capped at 10 MB by the logger's rotation, but
  the viewer calls it every 2 s.
- **Rotated files are invisible.** The logger rotates at 10 MB to `<name>.log.1` and `<name>.log.2`; those names don't
  end in `.log`, so neither the list nor `log_tail` will open them.
- **The dashboard waits behind slow methods.** Health checks that don't declare a read lane queue behind any long
  method running in the same extension, so a card can lag or time out while that extension is busy.
- **The method description says `~/.anima/logs/`.** The real folder is `<data dir>/logs`, which differs from
  `~/.anima/logs` when `ANIMA_DATA_DIR` is set (as in a second, isolated instance).
- **A card's status is the extension's own verdict.** The dashboard only shows it. Skills, for instance, reports
  `degraded` for problems in your real `~/.claude/skills` folder, so a brand-new install can show it
  ([skills.md](skills.md)).
- **Actions run with the browser's gateway connection.** Any method an extension names in an action is callable from
  the dashboard with one click, so treat `actions` in a health response as UI that can change things.

## Code map

- `src/index.ts`: the three methods; log file filtering and tailing.
- `src/routes.ts`: `/control` and `/logs` routes and the launcher tile.
- `src/pages/MissionControlPage.tsx`: discovery, health polling, response normalization, actions.
- `src/pages/LogViewerPage.tsx`: file picker, 2 s tail loop, level filter.
- `src/hooks/useGatewayRpc.ts`: the pages' gateway request helper.
- `src/index.test.ts`: method tests.
