-- Up

-- The last time the board sent an item's session back to it (`today.follow_up`, or the automatic
-- follow-up when one of the user's PRs changed after its session finished): when, for which state of the
-- PR (`<state kind>@<source updated at>`, so one change prompts once), and how many automatic ones
-- in a row while the PR kept needing us (reset once it stops), so a session never loops on it.
ALTER TABLE today_items ADD COLUMN follow_up_at TEXT;
ALTER TABLE today_items ADD COLUMN follow_up_key TEXT;
ALTER TABLE today_items ADD COLUMN follow_up_auto INTEGER NOT NULL DEFAULT 0;

-- Down

ALTER TABLE today_items DROP COLUMN follow_up_auto;
ALTER TABLE today_items DROP COLUMN follow_up_key;
ALTER TABLE today_items DROP COLUMN follow_up_at;
