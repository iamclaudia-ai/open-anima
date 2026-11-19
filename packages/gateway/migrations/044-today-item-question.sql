-- Up

-- A question a session asked the user about an item (`today.ask`): shown on the
-- board under the item until the user's next message reaches that session. The
-- phone is pinged once if it's still unanswered after a while.
ALTER TABLE today_items ADD COLUMN question TEXT;
ALTER TABLE today_items ADD COLUMN asked_at TEXT;
ALTER TABLE today_items ADD COLUMN question_notified_at TEXT;

-- Down

ALTER TABLE today_items DROP COLUMN question_notified_at;
ALTER TABLE today_items DROP COLUMN asked_at;
ALTER TABLE today_items DROP COLUMN question;
