# Notify extension

Notify is how anything in Anima reaches you when you aren't looking at it: a scheduled task that broke, a session
waiting on your answer. It has one real method, `notify.send`, and sends the message through one delivery set in
config: the extension log (the default), a macOS notification, a program of yours, or a webhook. Identical messages
inside a dedupe window go out once, so a loop or a task failing every five minutes can't flood you. Two extensions
call it: the scheduler (`extensions/scheduler/src/failure-notify.ts`, on a task's first failure and on its recovery)
and Today (`extensions/today/src/questions.ts`, for a question a session asked that nobody answered in 10 minutes).
Both catch errors, so a host without notify still runs. Notify makes no `ctx.call` requests, emits no events and
listens to none.

## Methods

Both run on the default serial write lane (neither declares `execution`), so one slow delivery holds up the next
`notify.send`.

| Method                | Purpose                                                                                                                 | Params                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notify.send`         | Deliver a notification. Returns `{ sent: true, via }` or `{ sent: false, deduped: true }`; throws if the delivery fails | `message` (1 to 1500 chars, required), `title` (up to 120, default `Anima`), `source` (up to 80: who is asking), `host` (up to 40, default this host's name) |
| `notify.health_check` | Health card: host, delivery type, recent sends and failures, the last 5 sends                                           | none                                                                                                                                                         |

From a shell: `anima notify send --message "Backup failed" --title "Task failed" --source backup`.

## Web pages

None.

## Config

`extensions.notify.config` in `~/.anima/anima.json`, parsed by `src/config.ts`:

| Key              | Default                                | Meaning                                        |
| ---------------- | -------------------------------------- | ---------------------------------------------- |
| `delivery`       | `{ "type": "log" }`                    | Where messages go (below)                      |
| `host`           | the machine's hostname, minus `.local` | How this host names itself in messages         |
| `dedupeWindowMs` | `600000` (10 min)                      | Identical text inside this window is sent once |

An unknown `delivery.type` (or a malformed delivery) fails config parsing, so the extension doesn't start.
`anima.example.json` covers all three keys (the last two commented) and lists all four delivery types.

### Deliveries

| `type`    | Fields                                                                                          | What it does                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log`     | none                                                                                            | Writes `Notification` with the text to the extension log. Nothing reaches you.                                                                                                                                                                          |
| `macos`   | `sound` (optional, a name from `/System/Library/Sounds`, e.g. `Glass`)                          | Runs `osascript -e 'display notification …'` with the title, the message, and `<source> on <host>` as subtitle. 10-second timeout.                                                                                                                      |
| `command` | `argv` (program and args, required), `timeoutMs` (default `15000`)                              | Runs the program (no shell) with the formatted text on stdin. A leading `~/` in the program path is expanded; arguments are passed as they are. Non-zero exit or timeout is a failure; the first 300 chars of stderr go in the error.                   |
| `webhook` | `url` (http or https, required), `format` (`text` default, or `json`), `headers` (default `{}`) | POSTs. `text`: body is the message only, `Content-Type: text/plain`, plus a `Title` header (the shape ntfy reads). `json`: body is `{ title, message, source, host, text }`. Your `headers` are added last and override. A non-2xx answer is a failure. |

The formatted text (`formatNotification` in `src/index.ts`), which `log` and `command` receive and the `json` body
carries as `text`:

```
🔔 <title>
<message>
— <source> on <host>
```

## How it works

`notify.send` (`src/index.ts`) parses its params, builds the formatted text, and checks the dedupe map: if the same
text was sent less than `dedupeWindowMs` ago, it records a deduped entry and returns `{ sent: false, deduped: true }`.
Otherwise it claims the slot before sending (so two identical calls racing each other still send once), calls
`deliver` (`src/deliveries.ts`), and returns `{ sent: true, via }`, where `via` is `log`, `macos`,
`command:<program>` or `webhook:<host>`. On failure it releases the slot, so an immediate retry is allowed, and
rethrows.

The dedupe key is the whole formatted text, so the same message with a different `title`, `source` or `host` is a
different message. The dedupe map and the last 20 sends (what `notify.health_check` reports) live in memory only and
reset when the extension restarts. Health is `degraded` when the most recent send failed. Nothing is stored in the
database.

## Adding your own delivery

**Without code: a `command` delivery.** Point it at any script that reads stdin. That covers push services, chat
bots, a bridge to text messages, a desk light:

```json
"notify": {
  "enabled": true,
  "config": { "delivery": { "type": "command", "argv": ["~/bin/notify-me"], "timeoutMs": 20000 } }
}
```

```bash
#!/usr/bin/env bash
# ~/bin/notify-me: the formatted notification arrives on stdin.
text=$(cat)
curl -fsS --data-binary "$text" "https://ntfy.sh/your-topic"
```

Exit non-zero to report a failure: `notify.send` then throws and the caller sees the error (the scheduler logs it).

**In code: a new delivery type.**

1. Add a variant to `DeliverySchema` in `src/config.ts` (a `z.object` with `type: z.literal("<name>")` and its
   fields). Defaults declared there apply, since the config is parsed with this schema.
2. Add a `case "<name>":` to `deliver()` in `src/deliveries.ts` that sends `notification` (`title`, `message`,
   `source`, `host`, and the formatted `text`) and returns `{ via: "<name>" }`. Throw on failure. `deliver` has a
   declared return type and no `default`, so the type checker reports a variant you forgot to handle.
3. Reach the outside world through `deps` (`run` for programs, `fetch` for HTTP, `log`) rather than calling
   `Bun.spawn` or the global `fetch` directly: `createNotifyExtension(config, overrides)` takes replacements for
   these, which is how `src/index.test.ts` tests every delivery without sending anything.
4. Update the delivery list in the comment at the top of `src/config.ts`, in the `notify.send` description in
   `src/index.ts`, and in `anima.example.json`.

Only one delivery per host. To send to two places, use a `command` script that fans out.

## Gotchas

- **The `text` webhook encodes non-ASCII titles.** The title goes into an HTTP `Title` header, and Bun's `fetch`
  rejects header values outside Latin-1, so a non-ASCII title is sent RFC 2047-encoded (`=?UTF-8?B?…?=`). A
  receiver that doesn't decode that shows the encoded form. Keep titles ASCII, or use `format: "json"` or a
  `command` delivery.
- **Webhooks have no timeout.** `deliver` calls `fetch` without a signal, and the method runs on the serial lane, so a
  webhook that never answers holds up every later `notify.send`. `command` deliveries are killed after `timeoutMs`.
- **The method description says "10 minutes"** whatever `dedupeWindowMs` is set to.
- **`log` is the default**, so a fresh install's notifications only reach `notify`'s log file. Pick a real delivery
  before relying on scheduler alerts or Today's questions.
- **`command` output is ignored** apart from stderr on failure, and the program runs without a shell, so pipes and
  `$VARS` in `argv` are not interpreted.

## Code map

| File                | What it holds                                                                     |
| ------------------- | --------------------------------------------------------------------------------- |
| `src/index.ts`      | Extension: `notify.send` with dedupe, `notify.health_check`, `formatNotification` |
| `src/config.ts`     | `DeliverySchema`, config defaults, host name                                      |
| `src/deliveries.ts` | `deliver()` (one case per delivery type), `macosScript`, `runProgram`             |
| `src/index.test.ts` | Each delivery and the dedupe rules, with injected `run` and `fetch`               |
