-- The plan reads itself (items/plan_settle.rs). For a work item in Triage,
-- where g1t suggests it goes (suggestion: JSON { horizon, appetite,
-- duplicate_of, why }), asked of the workspace's AI provider once
-- (suggested_at, set even when there was no answer). For one in Now, where it
-- stands in a sentence or two (standing), drafted when something new has
-- happened on it since standing_at.
ALTER TABLE work_items ADD COLUMN suggestion TEXT;
ALTER TABLE work_items ADD COLUMN suggested_at TEXT;
ALTER TABLE work_items ADD COLUMN standing TEXT;
ALTER TABLE work_items ADD COLUMN standing_at TEXT;

CREATE INDEX work_items_unsuggested ON work_items (state, horizon, suggested_at) WHERE state = 'open';
