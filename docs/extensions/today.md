# Today extension

Today is a daily board at `/today`: one list of what wants your attention across your projects. It collects PRs
waiting on your review, your own open PRs, merged PRs of yours that production doesn't have yet, Linear issues
assigned to you, and promises from a ledger file, and keeps that list current by re-reading every source on a timer.
Each item has a **Start** button that opens an agent session already prompted to work on it, and the board follows
that session: it shows when the session is working, puts the session's questions under the item, sends the session
back when one of your PRs needs work again, and marks it done when every item it works has closed. The judgment work
(which few things matter today, a short morning note) comes from an agent session you schedule, through
`today.set_top` and `today.set_note`.

It uses the session extension (`session.create_session`, `session.send_prompt`, `session.set_title`,
`session.set_status`, `session.list_attention`) and notify (`notify.send`, for questions nobody answered). It listens
to `session.status_changed` and `session.*.handoff`, and emits `today.changed` (`{ reason, at }`, so open pages reload)
and `today.needs_you` (`{ itemId, title, message, url }`, a toast and desktop notification in every open Anima tab,
shown by `packages/ui/src/components/GlobalNotifications.tsx`).

## Methods

There are 17. Three reads run on the parallel `read` lane. `today.refresh` declares
`{ lane: "control", concurrency: "parallel" }`, so it also runs at once and never queues; concurrent refreshes share
the one collection pass in flight. Everything else runs on the default serial write lane, one call at a time.

Most methods that act on one item take `id` (number) or `key` (string, e.g. `linear:ENG-123`,
`review:acme/app#12`); one of the two is required.

| Method               | Lane               | Purpose                                                                                                   | Notable params                                                                                                                       |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `today.list`         | read               | Items (open by default), today's date and zone, the note, each source's last collection, any GitHub pause | `doneSince` (ISO), `project`, `section`, `status` (`open`/`done`/`dismissed`/`all`), `doneBy`                                        |
| `today.board`        | read               | The live board as `/today` shows it: top picks, waiting items, questions, queue progress, `notePicks`     | none                                                                                                                                 |
| `today.health_check` | read               | Status per source, failing count, GitHub pause, open item count                                           | none                                                                                                                                 |
| `today.refresh`      | control (parallel) | Collect now. Returns `{ skipped, collections }`                                                           | `project`, `maxAgeSeconds` (skip if every source is younger; omit to force GitHub too)                                               |
| `today.complete`     | write              | Mark done. Stays done until the source changes after this moment                                          | `by` (`user`/`agent`, default `user`), `note`                                                                                        |
| `today.dismiss`      | write              | Drop an item that isn't yours (same reopen rule)                                                          | `by`, `note`                                                                                                                         |
| `today.reopen`       | write              | Put a done or dismissed item back                                                                         | `by`, `note`                                                                                                                         |
| `today.pin`          | write              | Pin (or unpin) an item into the top picks queue                                                           | `pinned` (default `true`)                                                                                                            |
| `today.snooze`       | write              | Snooze a Linear ticket (or a promise with a ticket) in Linear itself                                      | `until` (ISO datetime, `2099-01-01T00:00:00.000Z` for "until I unsnooze", `null` unsnoozes)                                          |
| `today.launch`       | write              | Start (or return) the item's session; a stacked PR starts one session for the whole stack                 | `restart` (default `false`), `context` (your note, up to 4000 chars)                                                                 |
| `today.follow_up`    | write              | Send the item's session back to it (the Continue button)                                                  | `context`                                                                                                                            |
| `today.review_queue` | write              | One session per project that works through every open review without a session                            | `project`, `context`                                                                                                                 |
| `today.nudge`        | write              | Draft a "please review" message for one of your PRs and record when you nudged. Posts nothing             | returns `{ item, draft, channel }`                                                                                                   |
| `today.ask`          | write              | A session puts a question to you under an item                                                            | `question` (1 to 500 chars)                                                                                                          |
| `today.set_top`      | write              | Replace a date's ranked picks (up to 25, each with an optional reason)                                    | `date` (default today), `picks: [{ key, reason? }]`                                                                                  |
| `today.set_note`     | write              | Write a date's note (up to 600 chars) and record the live picks it was written over                       | `date`, `text`                                                                                                                       |
| `today.add_item`     | write              | Add or update (by key) an item no collector owns                                                          | `key` (default `manual:<random>`), `project`, `section` (default `promise`), `title`, `url`, `waitingOn`, `dueDate`, `since`, `note` |

`today.launch`, `today.review_queue` and `today.snooze` wait on other services (session creation, Linear), and because
they share the serial lane, a slow one holds up the next pin or dismiss.

## Web pages

From `src/routes.ts` (launcher tile "Today", Lucide `Sunrise` icon):

| Route             | Page                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `/today`          | Overview: the note, questions for you, the top 5 picks, what waits on others, section tiles |
| `/today/:section` | One section. Slugs: `promises`, `reviews`, `prs`, `tickets`, `promote`                      |

The five sections (`section` values in the store, labels from `SECTIONS` in `src/pages/model.ts`):

| `section` | Label            | Comes from                                                                     |
| --------- | ---------------- | ------------------------------------------------------------------------------ |
| `promise` | Promises         | The promise ledger, Linear issues carrying the promise label, `today.add_item` |
| `review`  | Reviews          | `tools/check-review-queue` (PRs waiting on your review)                        |
| `my_pr`   | Your PRs         | `tools/check-my-prs` (your open PRs, each reduced to one state)                |
| `ticket`  | Tickets          | Linear issues assigned to you                                                  |
| `promote` | Ready to promote | The deploy check: your merges that an app's production tag doesn't contain     |

The page loads `today.list` (with `doneSince` = start of today, so today's ticks show struck through), reloads on
`today.changed`, and calls `today.refresh` with `maxAgeSeconds: 60` when it comes into view and every 2 minutes while
visible. The Refresh button calls it without `maxAgeSeconds`, which forces GitHub sources too. The last board is
cached in memory and `localStorage` so a page opens on it at once (`src/pages/board-cache.ts`); a board from another
day is never shown. The Reviews page has **Review all** (`today.review_queue`), the Tickets page a phase plan from
Linear milestones. Each section page shows a canned note picked at random from `src/pages/notes.ts`; edit those to
taste.

## Config

`extensions.today.config` in `~/.anima/anima.json`, parsed by `src/config.ts`:

| Key                     | Default             | Meaning                                                                                           |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `intervalMinutes`       | `5` (1 to 240)      | Background collection timer                                                                       |
| `githubIntervalMinutes` | `5` (1 to 240)      | A GitHub source collects at most this often, however often the page refreshes                     |
| `githubReserve`         | `1000`              | Pause GitHub collection while fewer GraphQL points than this are left in the hour                 |
| `timeZone`              | this machine's zone | IANA zone for "today" (top picks' and notes' date)                                                |
| `linear.apiKey`         | none                | Linear personal API key for every project (else `LINEAR_API_KEY` in the environment)              |
| `approvals`             | all `true`          | `{ push, merge, post, deploy }`: which steps the session prompts tell sessions to ask about first |
| `sessionProfile`        | `"yolo"`            | Permission profile for every session the board starts (launch, stack, review queue)               |
| `projects`              | `[]`                | One entry per project, below                                                                      |

Each project:

| Key                     | Default  | Meaning                                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`                  | required | Label shown on items; also prefixes source names                                                       |
| `cwd`                   | required | Project folder: collectors run here, sessions start here. Must be inside a git repo for `github.mine`  |
| `github.repos`          | `[]`     | `owner/repo` list collected every pass                                                                 |
| `github.org`            | none     | Also every repo in this org with an open PR of yours or one you review (found by `gh search`)          |
| `github.reviews`        | `true`   | Collect PRs waiting on your review                                                                     |
| `github.mine`           | `true`   | Collect your own open PRs                                                                              |
| `github.deploys`        | off      | Turn on the Ready to promote check: `{ days: 60, graceHours: 24, intervalMinutes: 30 }`                |
| `linear`                | off      | `{ promiseLabel: "Promise", apiKey? }`. Must be present (even `{}`) for Linear to run for this project |
| `worktree.branchPrefix` | `""`     | Presence of `worktree` starts each item's session in its own git worktree; prefix for new branches     |
| `promiseLedger`         | none     | Path to a promise ledger JSON file (shape in `src/collectors/ledger.ts`)                               |
| `reviewChannel`         | none     | Channel name (no `#`) returned by `today.nudge` so the page can say where to paste                     |

`github` needs `repos`, `org`, or both.

`anima.example.json` shows `intervalMinutes`, `approvals`, a commented top-level `linear.apiKey`, and one project with
`github.repos`, `reviews`, `mine`, `worktree` and a commented project `linear` block. It leaves out
`githubIntervalMinutes`, `githubReserve`, `timeZone`, and the project keys `github.org`, `github.deploys`,
`promiseLedger` and `reviewChannel` (the defaults above apply). Linear needs both a key and a project `linear` block:
a key alone collects nothing.

### What it needs installed

- **`gh`**, logged in, for every GitHub source. Collectors run it with the project folder as cwd, so a `gh` setup that
  picks its account by folder picks the project's. Extensions inherit the watchdog's login `PATH`.
- **`jq` and `bash`** for the two bundled scripts in `extensions/today/tools`. They are run by absolute path, so
  nothing needs to be on `PATH` but `gh` and `jq`. Both are read-only towards GitHub and usable on their own in a
  terminal:
  - `check-review-queue --json -R <repo>`: requested, team and follow-up reviews. The board drops `team` rows. It
    keeps a "new since last check" cache in `.git/review-queue-cache.json` (JSON mode leaves it alone) and a quiet
    list in `.git/review-queue-quiet.json`; `--quiet N` hides PR N until it's updated, on the board too. When the cwd
    has no `.git` directory, both fall back to `$TMPDIR` and `~/.review-queue-quiet.json`.
  - `check-my-prs --json --all -R <repo>`: your open PRs with review, thread and check state. Cache at
    `<git common dir>/pr-status-cache.json`. `CPRA_DESIGNERS` (comma-separated logins, read from the extension's
    environment) names reviewers whose approval alone doesn't count. Uses `gh-stack stacks --json` for stack names
    when `gh-stack` is installed (optional).
- **Linear** needs only an API key; requests go straight to `https://api.linear.app/graphql`.
- The **`anima` CLI** on the session's `PATH`: every session prompt tells the session to run `anima today ask`,
  `anima today complete` and `anima session set_status`.

## How it works

### Collection and reconciliation

`start()` runs one collection pass at once and then every `intervalMinutes` (`collectAll` in `src/index.ts`). A pass
walks each project's sources (`projectSources`). Source names are `<project>:linear`, `<project>:reviews:<repo>`,
`<project>:mine:<repo>`, `<project>:deploys` and `<project>:ledger`; discovery records its status as
`<project>:discovery`. Only one pass runs at a time; a second caller waits on the same promise.

Each source hands its **full open set** to `applyCollection` (`src/store.ts`), which reconciles by item key in one
immediate transaction:

- a new key becomes an open row;
- an open row present again has its fields refreshed;
- an open row missing from a successful collection is closed (`done_by = 'collector'`): the ticket closed, the PR
  merged, the review posted;
- a row the collector closed comes back if it reappears;
- a row you or an agent closed or dismissed stays closed until the source's `sourceUpdatedAt` is later than your
  `completed_at`.

A collection that throws changes nothing, so a source that is down never closes its items. After the sources, the
pass links new stack members to their stack's session (`linkStackSessions`), marks sessions finished (below), runs
automatic follow-ups, and emits `today.changed`.

Item keys: `linear:<ID>`, `review:<owner>/<repo>#<n>`, `pr:<owner>/<repo>#<n>`, `deploy:<repo>#<n>:<app>`,
`slack:<ledger key>` (ledger entries, whatever chat they come from) and `manual:<8 chars>`. Keys are unique across
the whole table.

### The collectors (`src/collectors/`)

| File               | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.ts`        | Runs the two bundled scripts per repo. `prState` reduces a PR to one state (`conflicts`, `checks_failing`, `changes_requested`, `your_turn`, `open_comments`, `re_request`, `ready`, `waiting_on_parent`, `unknown_base`, `ci_running`, `checks_unknown`, `needs_engineer`, `re_review`, `awaiting_reply`, `awaiting_review`, `draft`), a label, and whether a session can act on it now (`actionable`).                                                                                                                                                                                                                                                       |
| `discovery.ts`     | With `github.org`: three `gh search prs --owner <org>` calls (authored by you, review requested, reviewed by you). Search has its own rate limit, separate from GraphQL. When a discovered repo drops out, its source is collected empty once so its items close, but only on a pass where discovery succeeded.                                                                                                                                                                                                                                                                                                                                                |
| `github-budget.ts` | Reads `gh api rate_limit` (free) before a project's first GitHub source each pass. Below `githubReserve`, that project's GitHub sources pause until the reset; a collection failing with "rate limit" re-checks at once.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `deploys.ts`       | Ready to promote. Assumes one release convention: an app is a `.github/workflows/<app>-deploy-prod.yml` workflow (its `path-filters:` input names the paths it ships; none or `.` means the whole repo), production is the newest `<app>-prod-vN` tag. Your commits on the default branch since `days` ago are mapped to their PRs (squash `(#N)`, `Merge pull request #N`, else `commits/<sha>/pulls`); per app, newest first, merges older than `graceHours` are compared with the prod tag, and the first one production contains ends the walk. Workflows are re-read every 6 hours; one retry on HTTP 409 or 5xx. Adapt this file to your own convention. |
| `linear.ts`        | Every open issue assigned to the key's user (states not `completed`, `canceled`, `duplicate`), 100 per page, refusing a partial result past 1000. Issues with the promise label go to `promise`, the rest to `ticket`. Reads favorited projects and milestones to mark each issue's `activeProject` and `currentPhase`, and `snoozedUntilAt` into `meta.snoozedUntil`.                                                                                                                                                                                                                                                                                         |
| `ledger.ts`        | An example source: a JSON file something else keeps current. Only `"status": "open"` entries are collected, as promises.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `run.ts`           | Spawns a command with the extension's environment and a 60-second timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

GitHub sources run at most every `githubIntervalMinutes` (the deploy check every `deploys.intervalMinutes`), with 30
seconds of slack, unless forced by a Refresh without `maxAgeSeconds`.

### Top picks and the note

Nothing in the extension picks or writes them: an agent does, and no such job ships with this repo. The companion
open-skills collection (<https://github.com/iamclaudia-ai/open-skills>) has one ready to use: the
`running-today-sweeps` skill (a morning sweep, a daytime refresh, and example scheduler tasks). Or set one up yourself with the scheduler, for example a morning task that starts a session prompted to read `anima today list` and
`anima today board`, rank the day, then call `anima today set_top` and `anima today set_note` (in that order:
`set_note` records the live picks it was written over, and `today.board` returns them as `notePicks` so a later run
can tell when the note has fallen behind).

`set_top` replaces the picks for a date. A pick whose PR you nudged within the last 3 calendar days is left out and
reported in `quiet`; unknown keys come back in `missing`. The board then shows up to 5 live picks (`topPicks` in
`src/pages/model.ts`): today's ranked picks, then pinned items, keeping only what's yours to act on or being worked
now. When that queue runs short, the board's own ranking fills the rest. Reviews never take a place (Review all
clears them), a stack takes one place, and the last place goes to a ticket from an active project's current phase
when none made it in. A pick's reason shows until its state changes after `set_top`. Without a note, the overview
shows a generated one.

### Launch (Start)

`today.launch` (`launchItem` / `launchStack` in `src/index.ts`, prompts in `src/launch.ts`):

1. Returns the existing session if the item has one and `restart` is false. A double start of the same item throws
   ("Already starting a session for this item").
2. Picks the folder (`launchFolder`). Without `worktree` in the project config, the session starts in `cwd`, the main
   checkout. With it, `session.create_session` gets `worktree: <branch>`:

   | Section   | Branch                                                                                    |
   | --------- | ----------------------------------------------------------------------------------------- |
   | `my_pr`   | The PR's own head branch, so pushes land on the PR (throws if the item has no branch yet) |
   | `review`  | `<prefix>review-<number>`; a review stack `<prefix>review-stack-<bottom number>`          |
   | `ticket`  | `<prefix><slug>-<ID>`                                                                     |
   | `promise` | `<prefix>promise-<slug>`                                                                  |
   | `promote` | none: always the main checkout                                                            |

   The session extension creates or reuses the worktree; Today never removes one.

3. Creates the session with `profile: "yolo"` and `origin: "user"`, titled `Review: …`, `Land: …`, `Work: …`,
   `Keep promise: …` or `Ship …`, stores its id on the item, and sends the first prompt in the background
   (`streaming: true`; the prompt waits server-side for a worktree that is still being made).

The prompt reads as your own ask: the item's facts, your `context` note (placed ahead of the standing steps, and
told to win over them), what to do for this section, where the session is, the gate line, how to ask you, how the
item closes, and how to mark the session done.

**Stacks** (`src/stacks.ts`): your PRs chained by `parent`, a teammate's stack from the review queue's `stack` field,
and each app's Ready to promote PRs are each worked by one session. `planStackLaunch` reuses a session already working
the whole stack, else adopts the bottom-most PR's session (re-titling it and telling it the rest is its now), else
starts a new one in the bottom PR's worktree. A PR that joins a stack later is linked to that session on the next pass.

### Review queue

`today.review_queue` (`src/review-queue.ts`) starts one session per project in the main checkout (no worktree), titled
`Review queue · <project>`, and links every open review without a session to it. The prompt lists the queue, points at
the live queue (`check-review-queue --json -R <repo>`) as the source of truth, keeps the plan in
`tmp/reviews/QUEUE.md`, and tells the session to hand off when its context gets heavy. With `post` on, each review is
drafted in `tmp/reviews/<number>.md` and nothing is posted. Handoffs carry the links: on `session.<id>.handoff`, every
item linked to the old session moves to the new one (`followHandoff`).

### Follow-ups

After every pass, `followUp()` sends sessions back to your PRs that moved on (`src/follow-up.ts`). An item qualifies
when it is an open `my_pr` with a linked session, its state is actionable and one of `conflicts`, `checks_failing`,
`changes_requested`, `your_turn` or `open_comments`, its session isn't busy (running, waiting on a pane prompt, or
still making its worktree), nothing waits on you (a question, a `blocked` or `needs_review` session, an API error),
the session has been quiet 10 minutes, and this exact state (state kind plus the PR's `updatedAt`) hasn't been sent
before. At most one automatic follow-up per item per 30 minutes, and at most 3 in a row while the PR keeps needing
work; after that it waits for Continue. A stack's session gets all its PRs in one prompt. If the attention queue can't
be read, no automatic follow-up is sent. `ready` and `re_request` are actionable but never sent automatically.

`today.follow_up` (Continue) does the same by hand, with your `context`, and resets the automatic count. It throws
while the session is busy.

### Finishing sessions

When a pass closes items, or you complete or dismiss one, `finishedSessions` finds sessions whose every linked item is
now closed and calls `session.set_status { disposition: "resolved" }`, so they leave your Active list. A later prompt
reopens them.

### Questions (`today.ask`)

`today.ask` (`src/questions.ts`) writes the question on the item, sets the item's linked session to `blocked`, and
emits `today.needs_you`. The question clears, and the session goes back to `open`, on the next
`session.status_changed` for that session that is a turn starting after a non-running state (leaving a permission or
input prompt doesn't count). When a linked session stops on a pane prompt (`awaiting_input` or `awaiting_approval`),
the board also emits `today.needs_you`. A sweep every 60 seconds sends questions still open after 10 minutes through
`notify.send` (title `Needs your answer`, source `today`), once each; a failed send is retried on the next sweep.

### Nudge

`today.nudge` accepts only your open PR in state `awaiting_review`, `re_review` or `needs_engineer`. It records
`nudged_at` and returns `Could someone review this? [<title>](<url>)` plus `reviewChannel`. The page's button needs a
second click within 5 seconds, then copies the draft to your clipboard; you paste it. A nudge is "due" (the PR counts
as actionable again) 3 calendar days after the state began or after your last nudge.

### Snooze

`today.snooze` runs Linear's `issueUpdate(snoozedUntilAt)` with the project's key, then patches the item's `meta` so
the page updates before the next Linear read. A ledger promise snoozes through its `ticket`. Items with no Linear
ticket can't be snoozed. The page's choices end at 6 AM local time: tomorrow, a week, a month, or "until I unsnooze"
(2099-01-01).

## Human gates: what code enforces and what the prompt asks

`approvals` (`src/config.ts`) and `gateLine()` (`src/approvals.ts`) only shape **prompt text**. `gateLine` turns the
enabled gates into one paragraph appended to every prompt Today sends (launch, stack, review queue, follow-up):

> Stop and ask me before you do any of these: push a branch or open or update a PR; approve or merge a PR; post
> anything other people see (…); deploy, promote, or run a release workflow. Get it ready first (…), tell me what
> you're about to do and why, ask me on the board as described below, and wait for my go. A go covers what I said yes
> to, nothing more.

With one gate on it says "Stop and ask me before you <step>"; with all four off it returns `null` and the prompt has no
gate line. `post` also switches review prompts between "draft, don't post" and "post your verdict", and `deploy`
switches the promote prompt between "ask before running the deploy workflow" and "run it".

Enforced in code:

- The extension itself never pushes, merges, posts a review or comment, or deploys. The bundled scripts only read
  from GitHub. `today.nudge` returns a draft and posts nothing.
- Its external writes are: creating sessions and sending them prompts (including automatic follow-ups, which the
  board sends without asking you), setting session dispositions (`blocked`, `open`, `resolved`), Linear snoozes when
  `today.snooze` is called, and `notify.send`.

Prompt text only, not enforced:

- Every `approvals` gate, under the default `sessionProfile: "yolo"` (bypass permissions): no permission rule
  stands between a session and `git push`, `gh pr merge`, `gh pr review` or `gh workflow run`. A session that ignores
  its prompt can do all of them.
- "Never approve a promote yourself" in the promote prompt (always present, whatever `approvals` says).
- Drafting reviews to `tmp/reviews/` instead of posting them.
- Asking through `anima today ask`, closing items, and marking the session resolved when done.

If you need a hard gate, set `sessionProfile` to a profile whose `disallowedTools` deny those commands (an example
is in [HUMAN-IN-THE-LOOP.md](../HUMAN-IN-THE-LOOP.md)), and put the guard where the action happens too (branch
protection, required reviews, a deploy environment that needs approval).

## Data

In the shared `anima.db` (opened by the extension itself in WAL mode with a 5-second busy timeout; migrations
`042` to `052` in `packages/gateway/migrations`):

- `today_items`: one row per item: identity (`key`, `source`, `project`, `section`), display fields, `meta` (JSON from
  the collector), status (`open`/`done`/`dismissed`, `done_by`, `completed_at`), `pinned`, top picks (`top_date`,
  `top_rank`, `top_reason`, `top_at`), the linked session (`session_id`, `session_workspace_id`, `session_stack`),
  the question (`question`, `asked_at`, `question_notified_at`), `nudged_at`, `state_since`, follow-up bookkeeping
  (`follow_up_at`, `follow_up_key`, `follow_up_auto`), `source_updated_at`, `last_seen_at`.
- `today_notes`: one note per local date (`date`, `text`, `updated_at`, `picks` as a JSON array of keys).

Kept in memory only, and lost on restart: each source's last collection status, GitHub pauses, org discovery results,
and the deploy cache (apps per repo, your login, commit-to-PR lookups). After a restart every source collects again
on the first pass.

## Gotchas

- **A top-level Linear key does nothing alone.** `linearKey()` returns null unless the project has a `linear` block,
  so add `"linear": {}` to each project that should collect.
- **One Linear key collects every issue assigned to you**, not one project's. Two projects with Linear on and the same
  key both collect the same keys; since keys are unique, each pass moves those rows back and forth between the two
  projects. The same happens with a repo listed in two projects. Turn each source on in one project only.
- **`github.mine` needs a git repo.** `check-my-prs` runs `git rev-parse --git-common-dir` under `set -e`, so a
  project `cwd` outside a git repo fails that source on every pass.
- **Done isn't always done.** A ticked or dismissed item reopens when its source changes after the tick. For PRs that
  is the PR's `updatedAt`, which moves on any activity.
- **`maxAgeSeconds` rarely skips anything.** The freshness check needs every source collected within the window, but
  GitHub sources only collect every `githubIntervalMinutes` (and deploys every 30 minutes), so the page's 60-second
  window almost always fails and starts a pass. GitHub's own throttle is what protects the budget; Linear and the
  ledger are re-read on every such pass. Linear sources are also left out of the freshness check entirely.
- **A question can stick.** `today.ask` takes no session id: it blocks and later clears through the item's _linked_
  session. A question asked about an item no session is linked to (or linked to a different session) never clears
  by itself, and blocks automatic follow-ups for that item until the item closes.
- **Any new turn answers a question**, not only your message: a prompt from a scheduled task or a hand Continue into
  that session clears it too.
- **The nudge clock uses the machine's zone.** `nudgeDue` / `nudgeQuiet` compute dates with the machine's local time
  (`localDate` in `src/nudge.ts`), while the board's date uses `timeZone`.
- **Serial lane.** Launches wait on `session.create_session`; a slow one delays pins, dismissals and asks queued
  behind it.
- **Automatic follow-ups prompt sessions without you.** They carry the same gate line, but see the section above for
  what that does and doesn't guarantee.
- **Without `worktree`, side-by-side sessions share the main checkout**, and the review queue always runs there.

## Desktop client (`clients/desktop`)

`Today.app` shows `/today` in its own window with a global hotkey. Tauri 2, macOS only (needs the Rust toolchain to
build). It loads `http://localhost:<gatewayPort>/today` and opens every other link in your default browser
(`src-tauri/src/links.rs`). Settings live in `~/.anima/desktop.json` (or `$ANIMA_DATA_DIR/desktop.json`), defaults
`{ "hotkey": "F19", "gatewayPort": 30086 }`; set `gatewayPort` to your `gateway.port`. The hotkey shows or hides the
window; closing hides it. It waits for the gateway before loading, remembers its position per monitor setup
(`desktop-window-state.json`), and logs to `logs/today-app.log` in the same folder. Its web view has its own storage,
so the page asks for the gateway token (`anima token show`) on first launch. Build and install with
`cd clients/desktop && bun run install-app` (ad-hoc signed; set `APPLE_SIGNING_IDENTITY` to sign with your own
certificate). The page never calls Tauri, so swapping the wrapper only touches that folder.

## Code map

| File                                                        | What it holds                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/index.ts`                                              | Extension: methods, collection pass, launch, follow-up, finishing sessions, events |
| `src/config.ts`                                             | Config schema and defaults, `linearKey`, `localDate`                               |
| `src/approvals.ts`                                          | `ASK_FIRST` and `gateLine()`: the gate paragraph in every prompt                   |
| `src/launch.ts`                                             | Launch prompts, titles, worktree branches, stack planning and stack prompts        |
| `src/review-queue.ts`                                       | Review queue planning and prompt                                                   |
| `src/follow-up.ts`                                          | When to send a session back automatically, and the follow-up prompt                |
| `src/questions.ts`                                          | `today.ask`, answer detection, the notify sweep                                    |
| `src/nudge.ts`                                              | Who can be nudged, when a nudge is due, the draft text                             |
| `src/snooze.ts`                                             | Linear snooze mutation, snooze dates, promise-to-ticket snoozes                    |
| `src/stacks.ts`                                             | PR stacks and per-app promote groups                                               |
| `src/store.ts`                                              | `today_items` / `today_notes` access and the reconcile rules                       |
| `src/board.ts`                                              | `today.board`: the live board summary for agents                                   |
| `src/collectors/*.ts`                                       | GitHub, discovery, budget, deploys, Linear, ledger, command runner                 |
| `tools/check-review-queue`, `tools/check-my-prs`            | The bundled read-only GitHub scripts                                               |
| `src/pages/model.ts`                                        | Sections, lanes, ranking, top picks (shared by page and server)                    |
| `src/pages/ui.tsx`, `TodayPage.tsx`, `TodaySectionPage.tsx` | The page, auto-refresh, buttons                                                    |
| `src/pages/notes.ts`                                        | Canned per-section notes                                                           |
| `src/routes.ts`                                             | `/today` and `/today/:section`                                                     |
