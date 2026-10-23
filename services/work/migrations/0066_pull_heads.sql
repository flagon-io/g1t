-- A push's event can be handled twice: a retry after a later step failed,
-- or the sweep (heads.rs) replaying one the queue gave up on. The push
-- event that last moved a pull request's head, so that handling it again
-- finds the same pull requests it moved the first time.
ALTER TABLE pulls ADD COLUMN head_event TEXT;

-- When the sweep last compared the pull request's branch with its head.
-- Open ones are taken least recently compared first.
ALTER TABLE pulls ADD COLUMN head_swept_at TEXT;
CREATE INDEX IF NOT EXISTS pulls_head_swept ON pulls (head_swept_at) WHERE status IN ('draft', 'open');
