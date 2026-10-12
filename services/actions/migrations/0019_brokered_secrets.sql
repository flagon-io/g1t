-- Brokered secrets. A secret row with hosts is brokered: a workflow job is
-- given a stand-in for it in place of its value, and the runner Worker puts
-- the value on the job's requests to those hosts as they leave its sandbox.
-- The hosts are a JSON array of domains (`api.example.com`,
-- `*.example.com`); null for a secret that is not brokered.
ALTER TABLE settings ADD COLUMN brokered_hosts TEXT;

-- The stand-ins jobs were given: each a random token unique to one job and
-- one secret, its value sealed and bound to the stand-in, the hosts it is
-- filled in for, and when it stops working (the job's time limit and ten
-- minutes, in milliseconds since the epoch). Only a running job's own are
-- ever answered, with its token.
CREATE TABLE brokered_secrets (
  stand_in TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  hosts TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX brokered_secrets_by_job ON brokered_secrets (job_id);
CREATE INDEX brokered_secrets_by_expiry ON brokered_secrets (expires_at);

-- Whether a job was given any, so its log is masked for their values too
-- without asking on every report.
ALTER TABLE jobs ADD COLUMN brokered INTEGER NOT NULL DEFAULT 0;
