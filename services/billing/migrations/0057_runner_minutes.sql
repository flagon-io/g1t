-- Hosted runner time is charged by the job: its minutes, rounded up, at
-- the rate of the machine it ran on (g1t_contracts::actions::INSTANCE_TYPES).
-- A sandbox line records which machine (`2-core`, `4-core`), and its
-- quantity is then the minutes charged. Lines from before have no machine,
-- and their quantity stays seconds: the statement and the Usage page keep
-- reading them as sandbox time.
ALTER TABLE ledger ADD COLUMN machine TEXT;
