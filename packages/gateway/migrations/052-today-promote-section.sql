-- Up
--
-- The Today board's Tasks section gives way to Ready to promote: the user's merged PRs
-- that an app's production doesn't have yet, grouped by app on the page. Rows in the old
-- `task` section are dropped.
--
-- SQLite cannot alter a CHECK constraint, so this is a table rebuild carrying every column
-- added since 042 (043 session, 044 question, 045 session_stack, 046 nudged_at,
-- 047 state_since, 049 top_at, 051 follow-ups).

CREATE TABLE today_items_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  key                  TEXT NOT NULL UNIQUE,
  source               TEXT NOT NULL,
  project              TEXT NOT NULL,
  section              TEXT NOT NULL
                       CHECK(section IN ('promise', 'review', 'my_pr', 'ticket', 'promote')),
  title                TEXT NOT NULL,
  url                  TEXT,
  waiting_on           TEXT,
  state_label          TEXT,
  since                TEXT,
  due_date             TEXT,
  meta                 TEXT,
  note                 TEXT,
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open', 'done', 'dismissed')),
  done_by              TEXT CHECK(done_by IN ('user', 'agent', 'collector')),
  completed_at         TEXT,
  pinned               INTEGER NOT NULL DEFAULT 0,
  top_date             TEXT,
  top_rank             INTEGER,
  top_reason           TEXT,
  source_updated_at    TEXT,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  session_id           TEXT,
  session_workspace_id TEXT,
  question             TEXT,
  asked_at             TEXT,
  question_notified_at TEXT,
  session_stack        INTEGER NOT NULL DEFAULT 0,
  nudged_at            TEXT,
  state_since          TEXT,
  top_at               TEXT,
  follow_up_at         TEXT,
  follow_up_key        TEXT,
  follow_up_auto       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO today_items_new (
  id, key, source, project, section, title, url, waiting_on, state_label, since, due_date,
  meta, note, status, done_by, completed_at, pinned, top_date, top_rank, top_reason,
  source_updated_at, last_seen_at, created_at, updated_at, session_id, session_workspace_id,
  question, asked_at, question_notified_at, session_stack, nudged_at, state_since, top_at,
  follow_up_at, follow_up_key, follow_up_auto
)
SELECT
  id, key, source, project,
  section,
  title, url, waiting_on, state_label, since, due_date,
  meta, note, status, done_by, completed_at, pinned, top_date, top_rank, top_reason,
  source_updated_at, last_seen_at, created_at, updated_at, session_id, session_workspace_id,
  question, asked_at, question_notified_at, session_stack, nudged_at, state_since, top_at,
  follow_up_at, follow_up_key, follow_up_auto
FROM today_items
WHERE section != 'task';

DROP TABLE today_items;
ALTER TABLE today_items_new RENAME TO today_items;

CREATE INDEX idx_today_items_status ON today_items(status, section);
CREATE INDEX idx_today_items_source ON today_items(source, status);

-- Down

CREATE TABLE today_items_old (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  key                  TEXT NOT NULL UNIQUE,
  source               TEXT NOT NULL,
  project              TEXT NOT NULL,
  section              TEXT NOT NULL
                       CHECK(section IN ('promise', 'review', 'my_pr', 'ticket', 'task')),
  title                TEXT NOT NULL,
  url                  TEXT,
  waiting_on           TEXT,
  state_label          TEXT,
  since                TEXT,
  due_date             TEXT,
  meta                 TEXT,
  note                 TEXT,
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open', 'done', 'dismissed')),
  done_by              TEXT CHECK(done_by IN ('user', 'agent', 'collector')),
  completed_at         TEXT,
  pinned               INTEGER NOT NULL DEFAULT 0,
  top_date             TEXT,
  top_rank             INTEGER,
  top_reason           TEXT,
  source_updated_at    TEXT,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  session_id           TEXT,
  session_workspace_id TEXT,
  question             TEXT,
  asked_at             TEXT,
  question_notified_at TEXT,
  session_stack        INTEGER NOT NULL DEFAULT 0,
  nudged_at            TEXT,
  state_since          TEXT,
  top_at               TEXT,
  follow_up_at         TEXT,
  follow_up_key        TEXT,
  follow_up_auto       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO today_items_old
SELECT
  id, key, source, project,
  CASE WHEN section = 'promote' THEN 'my_pr' ELSE section END,
  title, url, waiting_on, state_label, since, due_date,
  meta, note, status, done_by, completed_at, pinned, top_date, top_rank, top_reason,
  source_updated_at, last_seen_at, created_at, updated_at, session_id, session_workspace_id,
  question, asked_at, question_notified_at, session_stack, nudged_at, state_since, top_at,
  follow_up_at, follow_up_key, follow_up_auto
FROM today_items;

DROP TABLE today_items;
ALTER TABLE today_items_old RENAME TO today_items;

CREATE INDEX idx_today_items_status ON today_items(status, section);
CREATE INDEX idx_today_items_source ON today_items(source, status);
