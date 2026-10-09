-- What a self-hosted runner can take, asked on every poll: queued jobs with
-- labels in its workspace, matched without regard to case. By the
-- lowercased namespace, so the match is a range of the index rather than
-- every labelled job.
CREATE INDEX IF NOT EXISTS jobs_self_hosted_lower ON jobs (lower(namespace), status) WHERE labels IS NOT NULL;
