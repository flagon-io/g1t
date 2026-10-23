-- A job asking for one of g1t's hosted Linux labels (`ubuntu-latest`) is
-- offered to the workspace's own runners first, and runs on g1t's machines
-- when none that fits is free, or none took it within 15 seconds
-- (`g1t_contracts::runners::falls_back`).
--
-- Whether a workspace (or a repository, over its workspace) offers them:
-- on by default, for the settings kept already too.
ALTER TABLE runner_settings ADD COLUMN prefer_own INTEGER NOT NULL DEFAULT 1;
-- For a job offered so: the machine g1t would give it (an `INSTANCE_TYPES`
-- label, `standard` included), which a runner must be as large as to take
-- it, and which it runs on if none does. Null for every other job. While
-- it is offered, its `labels` are its OS and architecture and `queued_at`
-- when it was offered; running on g1t's machines clears both.
ALTER TABLE jobs ADD COLUMN fallback_instance TEXT;
-- Whether it has `services:` or `container:`, which only a runner that
-- gives its jobs Docker can run.
ALTER TABLE jobs ADD COLUMN needs_docker INTEGER NOT NULL DEFAULT 0;
