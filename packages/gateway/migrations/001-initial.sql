-- Up

-- `general` and `pinned` are declared here rather than in a later migration.
--
-- They arrived in `016-workspaces-general-flag.sql`, which collided with
-- `016-memory-fts.sql` — `_migrations.id` is a primary key, so on any database
-- built from scratch the second id-16 file aborted the run and everything from
-- 16 onward was lost. On a database that was already past that point,
-- `memory-fts` won the race, so the flag migration never ran at all; the
-- columns existed only because `ensureSessionTable()` adds them defensively at
-- runtime, which is what hid the breakage. `pinned` never had a migration in
-- the first place, for the same reason.
--
-- Folding both into the initial schema is correct for a fresh database and a
-- no-op for an existing one, which already has the columns and already
-- recorded migration 1 as applied.
CREATE TABLE workspaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  cwd               TEXT NOT NULL UNIQUE,
  general           INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  active_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Down
DROP TABLE IF EXISTS workspaces;
