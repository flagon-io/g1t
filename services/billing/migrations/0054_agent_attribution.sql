-- Who an agent's usage is attributed to: the agent that did the work, by
-- handle, and the person who asked, by username. Every reply and session
-- step the agents service bills (a run under `<workspace>/@<handle>`), and
-- every repository run by @g1t from the runner, carries both, so Spend's
-- "by agent" and "by person" come from the one ledger that is charged,
-- with no second ledger to disagree with it.
ALTER TABLE runs ADD COLUMN agent TEXT;
ALTER TABLE runs ADD COLUMN asked_by TEXT;
ALTER TABLE ledger ADD COLUMN agent TEXT;
ALTER TABLE ledger ADD COLUMN asked_by TEXT;

-- What is already on the ledger, attributed once from what it says: a
-- line billed under `<workspace>/@<handle>` is that agent's (no repository
-- has an `@` in its name)…
UPDATE ledger SET agent = substr(repo, instr(repo, '/@') + 2)
 WHERE kind = 'usage' AND agent IS NULL AND repo LIKE '%/@%';
UPDATE runs SET agent = substr(repo, instr(repo, '/@') + 2)
 WHERE agent IS NULL AND repo LIKE '%/@%';
-- …and every other run, and every agent's sandbox, is g1t's own agent at
-- work on a repository: all g1t's work shows as @g1t. Who asked is not
-- known for these; lines from here on carry it.
UPDATE ledger SET agent = 'g1t'
 WHERE kind = 'usage' AND agent IS NULL
   AND (reference LIKE 'run%' OR (task = 'sandbox' AND compute = 'agent'));
UPDATE runs SET agent = 'g1t' WHERE agent IS NULL;
