# Scheduler extension

The scheduler runs tasks later or on a schedule: once (at a time or after a delay), every N seconds, or on a cron
expression. Tasks and their run history live in SQLite, so they survive restarts. A task's action can emit a gateway
event, call any extension method (`ctx.call`), show a notification in the web UI, or spawn a process. Failed runs can
retry, and a task that starts failing (or recovers) is reported through `notify.send`. Other parts of the system use
it too: `anima skills run --task` queues skill commands here as `exec` tasks, and `anima skills task` reads them back.
Anything the agent should do "at 9 every weekday" or "in 20 minutes" goes through this extension.

## Methods

None of the methods declares an `execution` lane, so all of them run on the extension's default serial write lane, one
at a time. `fire_now` returns as soon as the run has started for that reason.

| Method                      | Purpose                                                                          | Notable params                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduler.add_task`        | Create a task. Returns `{ ok, taskId, name, fireAt, type, cronDescription? }`    | `name`, `type` (`once`\|`interval`\|`cron`), `fireAt`/`delaySeconds`/`intervalSeconds`/`cronExpr`, `action`, `missedPolicy`, `concurrency`, `startDeadlineSeconds`, `tags`, `keepHistory`, `outputDir`, `retries`, `retryDelaySeconds`, `alertAfterFailures` |
| `scheduler.update_task`     | Change a task's settings, or enable/disable it                                   | `taskId` plus any of `name`, `description`, `cronExpr`, `action`, the policies, `tags`, `keepHistory`, `outputDir`, the retry/alert fields, `enabled`                                                                                                        |
| `scheduler.list_tasks`      | All tasks, with `cronDescription`                                                | `type`, `tags` (any match), `enabledOnly`                                                                                                                                                                                                                    |
| `scheduler.cancel_task`     | Delete a task and its history. Returns `removed` (0 if not found)                | `taskId`                                                                                                                                                                                                                                                     |
| `scheduler.fire_now`        | Start a task immediately, ignoring its schedule; does not wait                   | `taskId`                                                                                                                                                                                                                                                     |
| `scheduler.get_history`     | A task's executions, newest first                                                | `taskId`, `limit` (default 50)                                                                                                                                                                                                                               |
| `scheduler.update_progress` | Set the progress message on a running execution; emits `scheduler.task_progress` | `taskId`, `message`, `executionId` (else the latest `running` one), `meta`                                                                                                                                                                                   |
| `scheduler.health_check`    | Totals: tasks, cron jobs, pending, overdue                                       | none                                                                                                                                                                                                                                                         |

Events emitted: `scheduler.task_fired` (after a successful run), `scheduler.notification` (the `notification` action),
`scheduler.task_progress` (from `update_progress`).

### add_task in detail

When it fires:

| `type`     | Needs                                                                | Next fire time                                                 |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `once`     | `delaySeconds` or `fireAt` (ISO)                                     | Fires once, then the task is disabled (kept, with its history) |
| `interval` | `intervalSeconds`, plus `delaySeconds` or `fireAt` for the first run | `intervalSeconds` after each run _ends_                        |
| `cron`     | `cronExpr` (5 fields)                                                | The next matching minute after the run ends                    |

`delaySeconds` wins over `fireAt` if both are given. An `interval` task without a first time is rejected ("Either
fireAt, delaySeconds, or cronExpr is required").

The action (`action: { type, target, payload? }`):

| `action.type`    | `target`                    | What happens                                                                                                                                                                                              |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification`   | The message text            | Emits `scheduler.notification` `{ taskId, taskName, message, ...payload }`. The web UI shows a toast and, with permission, a browser notification (`packages/ui/src/components/GlobalNotifications.tsx`). |
| `emit`           | Event name                  | Emits that event with `{ taskId, taskName, ...payload }`.                                                                                                                                                 |
| `extension_call` | Method name (`notify.send`) | `ctx.call(target, payload)`. Throwing counts as a failed run.                                                                                                                                             |
| `exec`           | Program to run              | Spawns it; non-zero exit or timeout is a failure. Payload: `args` (string[]), `shell` (bool, default false), `cwd`, `timeoutMs` (default 60000), `env` (merged over the scheduler's own env).             |

Policies and history:

| Field                  | Default                                     | Meaning                                                                                                                                                                           |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missedPolicy`         | `fire_once`                                 | Cron only, applied at extension start: `fire_once` runs a missed task once, `skip` records a `skipped` run and moves on. `fire_all` behaves like `fire_once`.                     |
| `startDeadlineSeconds` | 3600 (when unset)                           | Cron only, at start: missed by more than this, the run is skipped whatever the policy.                                                                                            |
| `concurrency`          | `skip_if_running`                           | `skip_if_running` records a `skipped` run instead of starting a second copy. `allow` starts another. `cancel_previous` is accepted but not implemented (it behaves like `allow`). |
| `retries`              | 0 (max 10)                                  | Extra attempts inside the same execution. Only for actions safe to repeat.                                                                                                        |
| `retryDelaySeconds`    | 10                                          | Wait before the first retry; doubles each time, capped at 10 minutes.                                                                                                             |
| `alertAfterFailures`   | 1 (max 10)                                  | Failed runs in a row before `notify.send` is called.                                                                                                                              |
| `keepHistory`          | 50                                          | Executions kept per task; older ones are pruned after each run.                                                                                                                   |
| `outputDir`            | `<data dir>/tasks/<task-name-slug>/YYYY/MM` | Folder that `{{task.output_dir}}` resolves to (created on use).                                                                                                                   |

Example: run a backup script every night at 02:30, retry twice, and alert after two failed nights in a row.

```bash
bun run cli scheduler add_task --name "nightly backup" --type cron --cronExpr "30 2 * * *" \
  --action '{"type":"exec","target":"/usr/local/bin/backup","payload":{"args":["--to","{{task.output_dir}}"],"timeoutMs":600000}}' \
  --retries 2 --alertAfterFailures 2
```

## Template variables

`interpolate` (`src/template.ts`) expands `{{...}}` in a `notification` message and in an `exec` task's `target`,
`args` and `cwd`. Nothing else is expanded (not `emit`/`extension_call` payloads, not `exec` `env`). Unknown variables
are left as written.

| Variable                                                  | Value                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `{{date}}`, `{{time}}`, `{{datetime}}`                    | Local date/time; take a strftime-style format after `:` (`{{date:%Y-%m-%d}}`; tokens `%Y %m %d %H %M %S %j %u %s %Z %%`)       |
| `{{timestamp}}`, `{{epoch}}`, `{{epoch.ms}}`              | ISO time, Unix seconds, Unix milliseconds                                                                                      |
| `{{hostname}}`, `{{uuid}}`                                | Machine name, a fresh UUID                                                                                                     |
| `{{env.NAME}}` (or legacy `{{$NAME}}`)                    | An environment variable of the scheduler process                                                                               |
| `{{task.id}}`, `{{task.name}}`, ... `{{task.output_dir}}` | Task fields: `id`, `name`, `description`, `type`, `fireAt`, `cronExpr`, `createdAt`, `firedCount`, `lastFiredAt`, `output_dir` |

An `exec` process also gets `ANIMA_TASK_ID` and `ANIMA_EXECUTION_ID` in its environment, so it can report progress:
`anima scheduler update_progress --taskId "$ANIMA_TASK_ID" --executionId "$ANIMA_EXECUTION_ID" --message "Part 3 of 9"`.

## Web pages

| Route        | Page                          | What it does                                                                                                             |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/scheduler` | `src/pages/SchedulerPage.tsx` | Lists tasks (refreshes every 10 s), a form to add one, fire now, enable/disable, cancel, and the last 20 runs of a task. |

## Config

None. The factory ignores its config; `anima.example.json` has `"scheduler": { "enabled": true, "config": {} }`.
Failure alerts go through the notify extension, configured under `extensions.notify`.

## How it works

`start()` (in `src/index.ts`) moves any legacy `<data dir>/scheduled-tasks.json` into SQLite (renaming the file to
`.migrated`), then handles tasks that came due while the extension was down (`handleMissedTasks`): `once` and
`interval` tasks just fire; `cron` tasks follow `startDeadlineSeconds` and `missedPolicy`. Then a 5-second loop
(`checkAndFireTasks`) fires every enabled task whose `fire_at` is in the past.

`fireTask` applies the concurrency check, inserts a `running` execution, runs the action through `runWithRetries`
(`src/retry.ts`), and completes the execution as `success` (with up to 4 KB of combined stdout/stderr for `exec`) or
`error`. During retries the execution's progress message says which attempt failed and when the next one runs. After
each finished run `reportTransition` (`src/failure-notify.ts`) compares it with the earlier finished runs: the run that
makes the error streak reach `alertAfterFailures` sends "failed", and the first success after such an alert sends
"recovered", both via `notify.send` (best effort: without the notify extension it only logs). Then the next fire time
is written (`once` tasks are disabled, not deleted) and old executions are pruned.

Each task also gets its own log, `<data dir>/logs/scheduler-task-<taskId>.log`, with the command, its output and the
outcome.

Storage: two tables in the shared `anima.db`, created by gateway migrations (`018-scheduler-tables.sql`, then 019,
022, 031, 032): `scheduler_tasks` and `scheduler_task_executions` (deleted with their task). The extension opens its
own `bun:sqlite` connection with WAL and a 5-second busy timeout (`src/db.ts`).

## Gotchas

- **Cron is local time, and day-of-month AND day-of-week must both match.** Standard cron ORs the two when both are
  restricted; here `0 9 1 * 1` means "the 1st, if it is a Monday". Day-of-week is 0-6 (Sunday 0; `7` is out of
  range). The parser walks minute by minute up to two years ahead.
- **`missedPolicy` and `startDeadlineSeconds` only apply at start.** While the extension is running, the 5-second loop
  fires any overdue task once, however late (after the machine wakes from sleep, for example).
- **A long run keeps an interval or cron task "due".** Its next fire time is only written when the run ends, so every
  5-second tick sees it again: with `skip_if_running` that adds a `skipped` row per tick (history fills up, and
  `keepHistory` counts them), and with `allow` it starts a new copy every 5 seconds. `once` tasks are exempt from this.
- **The loop does not wait for itself.** Ticks run every 5 seconds whether or not the previous tick's runs finished,
  and each tick works from the list of due tasks it read at its start. A task that another tick already ran can be run
  again by a slower tick still holding the old list.
- **Catch-up runs block start.** `start()` awaits each missed task before the loop begins; a slow `exec` delays the
  extension coming up.
- **Executions cut off by a restart stay `running` forever.** Nothing marks them failed on start, and
  `update_progress` without `executionId` picks the latest `running` row, which may be one of those.
- **`exec` details.** `shell: true` joins `target` and `args` with spaces and runs `sh -c` (no quoting); without it,
  `target` is spawned directly with the scheduler's `PATH` (the gateway's environment, which under a service manager
  may be minimal: prefer absolute paths). `~` in `cwd` is not expanded. On timeout only the direct child is killed.
  Output is read after the process exits. A successful run keeps the first 4 KB of stdout and stderr in history; a
  failed one keeps only the error with the first 500 characters of stderr, and its stdout is not kept anywhere (the
  task log only records output for successful runs). Have a script that must be debuggable write its own log.
- **A `notification` reaches only open browser tabs.** It is an event, not a `notify.send`; if no web UI is open,
  nobody sees it. Use `extension_call` with `notify.send` to reach the user anywhere.
- **Schema defaults are not applied by the gateway.** Extension methods are not validated server side, so the handlers
  apply their own defaults. They do for every field except `action.type`: send it explicitly, or the insert fails the
  table's `NOT NULL` check.
- **`update_task` can't reschedule a `once` or `interval` task.** It accepts no `fireAt`, `delaySeconds`, `type` or
  `intervalSeconds`; only a new `cronExpr` moves the fire time. `list_tasks` doesn't return `intervalSeconds`
  either. Cancel and re-add instead.
- **The database path is resolved at import.** `src/db.ts` computes `<data dir>/anima.db` when the module loads, so set
  `ANIMA_DATA_DIR` before importing it (in tests, for example).

## Code map

- `src/index.ts`: methods, missed-task handling, the 5-second loop, `fireTask`, the actions.
- `src/db.ts`: task and execution queries, legacy JSON import.
- `src/cronParser.ts`: 5-field cron parsing, next run, human description.
- `src/template.ts`: `{{...}}` variables and `{{task.output_dir}}`.
- `src/retry.ts`: retries with doubling delay.
- `src/failure-notify.ts`: failed/recovered transitions and the `notify.send` call.
- `src/routes.ts`, `src/pages/SchedulerPage.tsx`: the `/scheduler` page.
- `packages/gateway/migrations/018-scheduler-tables.sql` (and 019, 022, 031, 032): the schema.
