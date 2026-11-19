-- Up

-- The session started from an item's Start button on /today, so the page can
-- link to it instead of starting a second one. The workspace id is kept
-- because the chat route needs it (/chat/<workspace>/<session>).
ALTER TABLE today_items ADD COLUMN session_id TEXT;
ALTER TABLE today_items ADD COLUMN session_workspace_id TEXT;

-- Down

ALTER TABLE today_items DROP COLUMN session_workspace_id;
ALTER TABLE today_items DROP COLUMN session_id;
