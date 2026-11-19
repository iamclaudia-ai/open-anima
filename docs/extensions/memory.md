# Memory extension

The memory extension gives the agent a long-term memory built from its own Claude Code transcripts. It ingests the
JSONL files Claude Code writes under `~/.claude/projects` into SQLite, splits them into conversations at quiet gaps,
and hands each finished conversation to **Scribe**, a summarizer that runs as an ordinary agent session under the
`scribe` profile and writes markdown memories (episodes, people, projects, milestones, insights) into the memory repo
(`$ANIMA_MEMORY_DIR`, default `~/memory`), which is committed to git after every conversation. Everything is
searchable with SQLite FTS5, by methods and by MCP tools that sessions get (`memory_recall`, `memory_remember`, ...).
It is the extension that talks to others the most: Scribe's sessions are created and driven through the session
extension (`session.get_or_create_workspace`, `create_session`, `send_prompt`, `get_info`, `get_history`,
`list_sessions`, `close_session`), and the session extension calls back into it (`memory.get_session_context` to put
recent context into a new session's system prompt, `memory.transition_conversation` when a session starts or is
switched to, `memory.search_transcripts` for session search). It is **disabled by default** in `anima.example.json`.

## Methods

Lanes: `read` methods run in parallel; `write` methods run one at a time; `health_check` runs in parallel on its own
`control` lane, so the dashboard never waits behind an ingest.

| Method                           | Lane    | Purpose                                                                                    | Notable params                                                                 |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `memory.health_check`            | control | State machine, watchers, scheduler, repo sync, counts by status; work items for `/control` | none                                                                           |
| `memory.ingest`                  | write   | Import a JSONL file or folder by hand; emits `memory.ingested`                             | `file` or `dir` (relative to `watchPath` unless absolute), `reimport`          |
| `memory.conversations`           | read    | Conversations, newest first                                                                | `status`, `limit` (default 50)                                                 |
| `memory.process`                 | write   | Move up to `batchSize` `ready` conversations to `queued` and wake Scribe                   | `batchSize` (default `processBatchSize`)                                       |
| `memory.process_conversation`    | write   | Queue one conversation for Scribe, whatever its status                                     | `id`, `dryRun` (return a 2000-character transcript preview, change nothing)    |
| `memory.get_transcript`          | read    | The formatted transcript Scribe would receive                                              | `id`                                                                           |
| `memory.transition_conversation` | write   | Mark the workspace's `active` conversations `ready` now, instead of after the gap          | `cwd`                                                                          |
| `memory.search`                  | read    | FTS5/BM25 over indexed memory documents (episodes included)                                | `query`, `limit` (20), `category`, `cwd`, `dateFrom`, `dateTo`                 |
| `memory.search_transcripts`      | read    | FTS5/BM25 over transcript messages, grouped by session                                     | `query` (FTS5 syntax), `limit` (20), `cwd`, `dateFrom`, `dateTo`, `sessionIds` |
| `memory.get_session_context`     | read    | Recent messages and archived summaries for a workspace (session bootstrap)                 | `cwd`, `includeAllSummaries`, `maxRecentMessages` (20), `maxSummaries` (5)     |
| `memory.calendar`                | read    | Conversations per day for a month                                                          | `month` (`YYYY-MM`)                                                            |
| `memory.day`                     | read    | A day's conversations                                                                      | `date` (`YYYY-MM-DD`)                                                          |
| `memory.month_range`             | read    | Earliest and latest month with data                                                        | none                                                                           |
| `memory.get_episode`             | read    | The episode markdown Scribe wrote for a conversation                                       | `id`                                                                           |

Events emitted: `memory.ingested` (manual `ingest` only), `memory.conversation_ready` (`{ count }` when the timer
marks conversations ready), `memory.processing_started` (`autoProcess` queued some), `memory.conversation_processed`
(`{ conversationId, status, queued }`). `memory.processing_complete` is declared but never emitted.

### MCP tools

The extension registers MCP tools (`mcp/tools.ts`); the gateway serves them at `/mcp`, and agent-host gives sessions
that endpoint as Anima's MCP server (unless the profile's `mcp` is `none`, as Scribe's is).

| Tool                | What it does                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `memory_recall`     | FTS search over indexed memory documents; `query`, `limit` (10), `category`, `dateFrom`, `dateTo`                    |
| `memory_remember`   | Write content into a file under the memory repo (optionally a `section`), then git commit and push in the background |
| `memory_note`       | Append to `notebooks/<notebook>.md` under a heading (default today's date); committed to git                         |
| `memory_read`       | Read a memory file, or one section of it                                                                             |
| `memory_list`       | List memory files, by category or most recent                                                                        |
| `memory_transcript` | Raw transcript entries for a conversation id (or an episode's source id), optional text filter                       |

Every path these tools take is resolved inside the memory repo; anything that lands outside it throws
(`resolveMemoryPath` in `mcp/storage.ts`).

## Web pages

| Route                 | Page                               | What it shows                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `/memory`             | `src/pages/MemoryCalendarPage.tsx` | Month heatmap of conversations (`memory.calendar`, `month_range`)         |
| `/memory/day/:date`   | `src/pages/DayTimelinePage.tsx`    | The day's conversations as cards (`memory.day`)                           |
| `/memory/episode/:id` | `src/pages/EpisodeDetailPage.tsx`  | Scribe's episode next to the transcript (`get_episode`, `get_transcript`) |

## Config

`extensions.memory.config` in `~/.anima/anima.json` (`MemoryConfig` in `src/config.ts`, defaults in `src/index.ts`):

| Key                       | Default              | Meaning                                                                                                                                                                   |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchPath`               | `~/.claude/projects` | Where Claude Code transcripts are read from. `~` is expanded.                                                                                                             |
| `watch`                   | `true`               | Watch `watchPath` for changes. With `false` there is no watcher, but the startup scan still runs.                                                                         |
| `conversationGapMinutes`  | 60                   | Silence that ends a conversation (splits it, and makes the last one `ready`).                                                                                             |
| `minConversationMessages` | 5                    | Shorter conversations are `skipped` by Scribe.                                                                                                                            |
| `processBatchSize`        | 10                   | Default `batchSize` for `memory.process` and for `autoProcess`.                                                                                                           |
| `autoProcess`             | `false`              | Queue `ready` conversations for Scribe automatically (every 30 s).                                                                                                        |
| `exclude`                 | `[]`                 | Transcript paths never to ingest: absolute (`/...` or `~/...`) prefixes, or prefixes of the path relative to `watchPath`. Scribe's own transcript folder is always added. |
| `timezone`                | system timezone      | IANA zone for transcript headers and episode file names.                                                                                                                  |
| `model`                   | `claude-sonnet-5`    | Model for Scribe's sessions.                                                                                                                                              |

`anima.example.json` has `enabled: false` and every key but `timezone` (mentioned in its comment) and `model`.

Scribe also needs the `scribe` session profile under `agentHost.sessionProfiles` (the example has it): `dontAsk`
permissions, tools `Read`, `Write`, `Edit`, `Glob`, `Grep` only, writes allowed under `~/memory` and
`~/.anima/memory/scribe/logs`, persona files and secret files denied, `mcp: "none"`.

## How it works

**Ingestion.** On start (`src/index.ts`, `src/state-machine.ts`) an XState machine goes `recovering` (roll back files
whose ingest was cut off, clear stale file locks) → `scanning` (incremental import of every JSONL under `watchPath`)
→ `startingWatcher` (an `fs.watch` watcher with debouncing for busy files, `src/watcher.ts`, then one catch-up pass)
→ `running`. Each file is tracked in `memory_file_states` by its path relative to `watchPath`, with a byte offset, so
only new lines are read (`src/ingest.ts`). The parser (`src/parser.ts`) keeps user messages and assistant text, plus
the names of tools used; tool inputs and outputs are not stored. Transcripts of Scribe's folder, of sessions the
session extension records as non-chat (subagents, reviews, tests), and anything in `exclude` are skipped.

**Conversations.** Entries of one file are split into conversations at gaps longer than `conversationGapMinutes`, and
also every 200 entries or 80 KB (`src/conversation.ts`). Status flow, in `memory_conversations.status`:

```
active ──(gap passed, 30 s timer)──> ready ──(memory.process / autoProcess)──> queued
queued ──(Scribe picks it up)──> processing ──> archived | skipped | review
```

`src/scheduler.ts` is the extension's own 30-second timer (unrelated to the scheduler extension): it marks
conversations `ready` and, with `autoProcess`, queues them. With the default `autoProcess: false`, nothing is
summarized until something calls `memory.process`.

**Scribe.** `ScribeWorker` (`src/scribe.ts`) takes the oldest `queued` conversation, one at a time. It skips it if it
has fewer than `minConversationMessages` entries, a formatted transcript over 100 KB, or an episode file already on
disk. Otherwise it opens a fresh session in the `scribe` workspace (`<data dir>/scribe`) with profile `scribe` and the
configured model, sends the system prompt (`src/prompts/scribe-system.md`) and waits for "ready", then writes the
transcript to `<data dir>/scribe/transcripts/<id>.md` and asks Scribe to process it. The prompt names the episode
path (`episodes/YYYY-MM/YYYY-MM-DD-HHMM-<id>.md`, in `timezone`) and the reasoning log
(`<data dir>/memory/scribe/logs/<id>.md`), and includes summaries of the previous conversations in the same file.
Scribe writes the files itself and answers `SUMMARY: ...` or `SKIP: ...`.

Then the worker runs `git add -A` and `git commit` in the memory repo (`scribe(<id>): <summary>`), checks the result
(a long summary with no files written, or a log that planned files none of which were written, means `review`),
stores the summary and file list, and asks `RepoSyncService` (`src/repo-sync.ts`) to `git pull --rebase` and
`git push` in the background. The session is always closed afterwards. A failed transcript is retried; after three
failures the conversation goes to `review`. A Scribe that can't start doesn't count against the conversation, and
the worker backs off (5 s doubling to 30 minutes). After a crash, a conversation left `processing` is recovered from
its session's history if Scribe had answered, else requeued.

**Search.** `memory_documents` holds every markdown file in the memory repo (except `scribe/`, `.git`,
`node_modules`), with a category from the first folder (`episodes`, `milestones`, `insights`, `relationships`,
`projects`, `core`, `personas`, `docs`, else `other`). A startup scan and a watcher on the repo keep it current
(`src/document-ingest.ts`, `src/document-watcher.ts`); triggers mirror it into `memory_search_fts`. Transcript
messages are mirrored into `memory_transcript_fts` (user messages, and assistant messages over 40 characters that
aren't just tool lists).

**Session context.** When the session extension bootstraps a session, it calls `transition_conversation` and then
`get_session_context` for the session's folder. Memory is per workspace: the folder's workspace root, worktrees,
added folders and the folders its chat sessions ran in all count (`workspaceFoldersFor` in `src/db.ts`, reading the
session extension's tables). An excluded folder gets nothing back.

**Storage.** Tables in the shared `anima.db` (gateway migrations `002-memory.sql` onward): `memory_transcript_entries`,
`memory_conversations`, `memory_file_states`, `memory_file_locks`, `memory_state_machines` (the persisted actor
snapshot), `memory_documents`, and the FTS5 tables `memory_search_fts` and `memory_transcript_fts`. Files: the memory
repo; `<data dir>/scribe/` (Scribe's workspace and `transcripts/`); `<data dir>/memory/scribe/logs/`; logs
`memory.log` and `memory-trace.log` (the detailed pipeline log) under `<data dir>/logs`.

## Setting it up

1. Make the memory folder a git repo (`git init ~/memory`; add a remote if you want it pushed). Scribe's results are
   only recorded through `git`.
2. Keep the `scribe` profile from `anima.example.json` under `agentHost.sessionProfiles`.
3. Set `extensions.memory.enabled: true` and restart the gateway.
4. Check `bun run cli memory health_check` (Actor State `running`), then `bun run cli memory conversations --status
   ready`, and `bun run cli memory process` to start summarizing, or set `autoProcess: true`.

## Gotchas

- **Scribe's prompt and profile hard-code `~/memory` and `~/.anima`.** The code honors `ANIMA_MEMORY_DIR` and
  `ANIMA_DATA_DIR`, but the system prompt, the per-conversation prompt (`Episode file: ~/memory/...`) and the
  example `scribe` profile's path rules don't. With a non-default memory repo, Scribe writes episodes to `~/memory`,
  the commit in the real repo finds nothing, and the conversation lands in `review`; with a non-default data folder its
  log writes are denied. Only the default locations work end to end.
- **Without git, everything goes to `review`.** If `git add` fails, the worker sees zero files written, and any summary
  of 50+ characters is flagged. Without a remote, every sync logs a failed `git pull --rebase`.
- **`git add -A` commits the whole repo.** Anything else changed in the memory folder (your own edits, a
  `memory_remember` still committing in the background) goes into Scribe's commit.
- **Scribe's 10-minute limit is really 5.** `processTranscript` races 10 minutes, but every `ctx.call` from an
  extension times out after 5 minutes (`CALL_TIMEOUT` in `packages/extension-host/src/index.ts`). A transcript that
  takes Scribe longer fails and counts as an attempt.
- **`watch: false` still scans.** The startup scan of `watchPath` runs regardless; point `watchPath` at an empty
  folder if the instance must not read transcripts (the test instance does both).
- **Nothing is summarized by default.** `autoProcess` is `false`: conversations pile up as `ready` until
  `memory.process` is called.
- **Re-processing an archived conversation marks it `skipped`.** `process_conversation` requeues it, and the worker
  then finds the episode file already there.
- **`memory.search` no longer covers conversation summaries.** Migration 017 removed them from the index (episodes
  replaced them), but the method description and the `summary` category still mention them. `memory.search`'s
  `cwd` filter only matches episodes, the only documents with a project.
- **Calendar days are UTC.** `calendar`, `day` and `month_range` group by `date(first_message_at)` in UTC, while
  episode names use `timezone`; an evening conversation can sit on the next day.
- **`memory.conversation_processed` reports `archived` for conversations flagged `review`.**
- **Transcript copies are never cleaned up.** `<data dir>/scribe/transcripts/<id>.md` holds the full text of every
  processed conversation.
- **`memory_remember` can write any file in the repo, persona files included.** Restricted profiles should get only
  `memory_note` (and the read tools).
- **Two database paths are fixed at import.** `src/db.ts` and `mcp/db.ts` compute `<data dir>/anima.db` when the
  module loads (unlike `src/paths.ts`), so set `ANIMA_DATA_DIR` before importing them.

## Code map

- `src/index.ts`: methods, config defaults, start/stop wiring of every part.
- `src/config.ts`, `src/paths.ts`: config type; memory repo, Scribe and log folders.
- `src/state-machine.ts`: startup recovery, scan, watcher start.
- `src/ingest.ts`, `src/parser.ts`, `src/watcher.ts`: JSONL import, parsing, file watching.
- `src/conversation.ts`: gap and size splitting into conversations.
- `src/scheduler.ts`: the 30-second ready/queue timer.
- `src/scribe.ts`, `src/prompts/scribe-system.md`: the Scribe worker and its instructions.
- `src/transcript-formatter.ts`: the text Scribe reads.
- `src/repo-sync.ts`: serialized pull/push of the memory repo.
- `src/document-ingest.ts`, `src/document-watcher.ts`: indexing the memory repo for search.
- `src/db.ts`: all queries, search, calendar, workspace folders.
- `mcp/tools.ts`, `mcp/storage.ts`, `mcp/db.ts`, `mcp/sections.ts`, `mcp/sync.ts`: the MCP tools.
- `src/routes.ts`, `src/pages/*`: the `/memory` pages.
