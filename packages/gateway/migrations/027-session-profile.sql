-- Up

-- The permission profile a session was created with (yolo, auto, or a configured one).
-- Written once at creation and never changed, then sent to agent-host with
-- every create and prompt, so a session resumed after a restart or an idle
-- reap comes back with the same powers it started with. NULL rows predate
-- profiles and read as yolo.
ALTER TABLE sessions ADD COLUMN profile TEXT;

-- Down

ALTER TABLE sessions DROP COLUMN profile;
