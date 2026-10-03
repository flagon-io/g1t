-- Reusable workflows: a job that calls a workflow in the repository, and
-- the jobs of that workflow, which join the run. As JSON:
--   the caller: {"role": "caller", "path", "source"};
--   a called job: {"role": "callee", "parent", "job", "path", "source", "inputs", "depth"}.
ALTER TABLE jobs ADD COLUMN call TEXT;
