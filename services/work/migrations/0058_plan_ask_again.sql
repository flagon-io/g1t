-- Triage suggestions the first deploy of the plan's upkeep asked for and
-- could not read (items/plan_settle.rs read only four lines then, and kept
-- no answer it could not read): asked again, once, now that a JSON answer
-- reads too. Only open work items still in Triage with no suggestion.
UPDATE work_items SET suggested_at = NULL
WHERE state = 'open' AND COALESCE(horizon, 'triage') = 'triage' AND suggestion IS NULL AND suggested_at IS NOT NULL;
