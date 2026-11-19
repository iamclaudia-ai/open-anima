-- Up
--
-- `runtime_status` gains `api_error`: Claude Code gave up on an API
-- failure and Anima's nudges couldn't revive the session, or the failure was
-- one a retry can't fix (rate limit, auth). The session is blocked on a human,
-- so the attention banner treats it like `awaiting_*` and calls it "stalled".
--
-- Why not reuse `stalled`: the reconnect sweep already writes that for any
-- live pane that has gone quiet, so it means "quiet", not "stuck".
--
-- SQLite cannot alter a CHECK constraint, so this is a table rebuild, like 024,
-- carrying the columns added since (profile 027, pinned 030, cwd 035).

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  provider_session_id TEXT NOT NULL UNIQUE,
  model               TEXT NOT NULL,
  agent               TEXT NOT NULL DEFAULT 'claude',
  purpose             TEXT NOT NULL DEFAULT 'chat',
  parent_session_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','awaiting_input','awaiting_approval','completed','failed','interrupted','stalled','api_error')),
  disposition         TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','needs_review','blocked','snoozed','resolved','archived')),
  title               TEXT,
  summary             TEXT,
  metadata_json       TEXT,
  previous_session_id TEXT,
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  profile             TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0,
  cwd                 TEXT
);

INSERT INTO sessions_new (
  id, workspace_id, provider_session_id, model, agent, purpose, parent_session_id,
  status, runtime_status, disposition, title, summary, metadata_json, previous_session_id,
  last_activity, created_at, updated_at, profile, pinned, cwd
)
SELECT
  id, workspace_id, provider_session_id, model, agent, purpose, parent_session_id,
  status, runtime_status, disposition, title, summary, metadata_json, previous_session_id,
  last_activity, created_at, updated_at, profile, pinned, cwd
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_disposition ON sessions(workspace_id, disposition);

PRAGMA foreign_keys = ON;

-- Down

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_old (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  provider_session_id TEXT NOT NULL UNIQUE,
  model               TEXT NOT NULL,
  agent               TEXT NOT NULL DEFAULT 'claude',
  purpose             TEXT NOT NULL DEFAULT 'chat',
  parent_session_id   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  runtime_status      TEXT NOT NULL DEFAULT 'idle' CHECK(runtime_status IN ('idle','running','awaiting_input','awaiting_approval','completed','failed','interrupted','stalled')),
  disposition         TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','needs_review','blocked','snoozed','resolved','archived')),
  title               TEXT,
  summary             TEXT,
  metadata_json       TEXT,
  previous_session_id TEXT,
  last_activity       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  profile             TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0,
  cwd                 TEXT
);

-- `api_error` has no older equivalent; the turn did end, so it reads as completed.
INSERT INTO sessions_old (
  id, workspace_id, provider_session_id, model, agent, purpose, parent_session_id,
  status, runtime_status, disposition, title, summary, metadata_json, previous_session_id,
  last_activity, created_at, updated_at, profile, pinned, cwd
)
SELECT
  id, workspace_id, provider_session_id, model, agent, purpose, parent_session_id,
  status, CASE WHEN runtime_status = 'api_error' THEN 'completed' ELSE runtime_status END,
  disposition, title, summary, metadata_json, previous_session_id,
  last_activity, created_at, updated_at, profile, pinned, cwd
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_old RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider_session ON sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_purpose ON sessions(workspace_id, purpose);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_disposition ON sessions(workspace_id, disposition);

PRAGMA foreign_keys = ON;
