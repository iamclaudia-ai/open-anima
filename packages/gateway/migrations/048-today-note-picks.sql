-- Up

-- The live top picks when the note was written (JSON array of item keys), so the day refresh
-- can tell when the board has moved on from what the note talks about.
ALTER TABLE today_notes ADD COLUMN picks TEXT;

-- Down

ALTER TABLE today_notes DROP COLUMN picks;
