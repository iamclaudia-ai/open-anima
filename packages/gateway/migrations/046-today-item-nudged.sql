-- Up

-- When the user last nudged reviewers about this PR (`today.nudge`), so
-- the board can say so and they don't bump it twice by accident.
ALTER TABLE today_items ADD COLUMN nudged_at TEXT;

-- Down

ALTER TABLE today_items DROP COLUMN nudged_at;
