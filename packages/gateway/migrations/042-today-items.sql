-- Up

-- The user's morning dashboard (extensions/today). One row per thing that wants
-- their attention: a promise owed, a PR waiting on their review, one of their own PRs
-- in review, a ticket assigned to them, or a task added by hand. (052 later
-- replaced the 'task' section with 'promote' and rebuilt this table.)
--
-- Collectors re-read each source (Linear, GitHub, a promise ledger) on
-- an interval and reconcile against `source`: an open row missing from a
-- successful collection is done. The user's own tick wins until the source
-- changes again (source_updated_at later than completed_at reopens it).
CREATE TABLE today_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable identity: linear:ENG-123, review:owner/repo#12, pr:owner/repo#12,
  -- slack:<channel>:<thread ts> (from the ledger collector), manual:<n>
  key               TEXT NOT NULL UNIQUE,
  -- Which collection owns the row (<project>:<collector>), or 'manual'
  source            TEXT NOT NULL,
  project           TEXT NOT NULL,
  section           TEXT NOT NULL
                    CHECK(section IN ('promise', 'review', 'my_pr', 'ticket', 'task')),
  title             TEXT NOT NULL,
  url               TEXT,
  -- Who is waiting on the user (or who they are waiting on, for their own PRs)
  waiting_on        TEXT,
  -- The source's own state, shown as a chip: "In Progress", "approved", "CI failing"
  state_label       TEXT,
  -- When the ask started: thread time, PR creation, ticket creation
  since             TEXT,
  due_date          TEXT,
  -- Collector-specific extras (JSON): priority, cycle, reviewers, …
  meta              TEXT,
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK(status IN ('open', 'done', 'dismissed')),
  done_by           TEXT CHECK(done_by IN ('user', 'agent', 'collector')),
  completed_at      TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  -- Today's top picks: set by the morning sweep for one local date
  top_date          TEXT,
  top_rank          INTEGER,
  top_reason        TEXT,
  source_updated_at TEXT,
  last_seen_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_today_items_status ON today_items(status, section);
CREATE INDEX idx_today_items_source ON today_items(source, status);

-- The morning note Anima leaves at the top of the page, one per local date.
CREATE TABLE today_notes (
  date       TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Down

DROP TABLE IF EXISTS today_notes;
DROP TABLE IF EXISTS today_items;
