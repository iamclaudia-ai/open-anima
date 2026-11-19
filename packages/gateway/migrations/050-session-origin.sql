-- Up

-- Who started a session. 'user' for a session the user opened themselves
-- (web chat, Today's launch button); 'automated' for anything an
-- agent, skill or scheduled task started (reviewers, syncs, nudges). The ACTIVE
-- pane files automated sessions in a collapsed Background group. Written once
-- at creation. NULL rows predate the column and read as 'user', so nothing
-- already in the queue moves.
ALTER TABLE sessions ADD COLUMN origin TEXT;

-- The session that started this one, when another session did (the CLI fills
-- it in from $ANIMA_SESSION_ID). Not parent_session_id, which is a subagent the
-- runtime knows about: this is only "who launched it", so the nav can nest a
-- reviewer under the work session that asked for it. Written once.
ALTER TABLE sessions ADD COLUMN launched_by_session_id TEXT;

-- Down

ALTER TABLE sessions DROP COLUMN launched_by_session_id;
ALTER TABLE sessions DROP COLUMN origin;
