-- The sizes a runner takes jobs asking for a hosted label for, as it last
-- said at registration or in a poll: a JSON array of g1t's machines by key,
-- each with the sandbox's CPUs and memory where the runner gives more than
-- the machine (`runners::OfferedSize`). Null for a runner that never said,
-- which takes those jobs by its `cpus` and `memory_mib` (migration 0030).
ALTER TABLE runners ADD COLUMN sizes TEXT;
