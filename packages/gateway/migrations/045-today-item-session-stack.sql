-- Up

-- 1 when the item's session works its whole PR stack (`today.launch` on a
-- stacked PR). A PR that joins the stack later is linked to that session too.
ALTER TABLE today_items ADD COLUMN session_stack INTEGER NOT NULL DEFAULT 0;

-- Down

ALTER TABLE today_items DROP COLUMN session_stack;
