-- Triage suggestions asked for before integrations' ai_brief left its model
-- room to think (the model thought through its whole answer length and
-- answered nothing): asked again, once. Only open work items still in Triage
-- with no suggestion.
UPDATE work_items SET suggested_at = NULL
WHERE state = 'open' AND COALESCE(horizon, 'triage') = 'triage' AND suggestion IS NULL AND suggested_at IS NOT NULL;
