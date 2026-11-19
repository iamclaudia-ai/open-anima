-- Up

-- When the item's state last changed (a PR's state kind, otherwise its state label), so the
-- board can tell how long something has waited on someone else and when a nudge is due.
-- Existing rows start from the source's last update: the closest guess there is.
ALTER TABLE today_items ADD COLUMN state_since TEXT;
UPDATE today_items SET state_since = COALESCE(source_updated_at, since, created_at);

-- Down

ALTER TABLE today_items DROP COLUMN state_since;
