-- What a job on a runner gets, as the runner last said at registration or
-- in a poll: its CPUs, its memory in MiB, and whether it can use Docker
-- (`services:`, `container:`). Null for a runner that never said, which
-- takes no job asking for a hosted label (migration 0029).
ALTER TABLE runners ADD COLUMN cpus INTEGER;
ALTER TABLE runners ADD COLUMN memory_mib INTEGER;
ALTER TABLE runners ADD COLUMN docker INTEGER;
