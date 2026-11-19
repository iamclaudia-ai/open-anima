-- Up

-- When the item was queued (`today.set_top`), so a pick's reason shows only while it's still
-- true: once the item's state changes after this, its flags speak instead. Existing picks count
-- from now (their last update), so today's reasons keep showing until something changes.
ALTER TABLE today_items ADD COLUMN top_at TEXT;
UPDATE today_items SET top_at = updated_at WHERE top_date IS NOT NULL;

-- Down

ALTER TABLE today_items DROP COLUMN top_at;
