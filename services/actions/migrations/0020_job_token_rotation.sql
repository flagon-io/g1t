-- A self-hosted runner's harness spends the job's token on fetching the
-- job, and gets a new one in its place (plan.rs `job_spec` with `rotate`).
-- The token the job started with stops working for everything but
-- `brokered_secrets`, which the runner Worker asks with the token it was
-- given at the start and which no API route passes on: its hash is kept
-- here from the swap until the job ends or is claimed again.
ALTER TABLE jobs ADD COLUMN first_token_hash TEXT;
