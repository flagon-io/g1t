-- Issues became work items (g1t #57): a webhook that asked for issue.*
-- events asks for the work_item.* events that replaced them, in the same
-- place in its list. Deliveries already made stay as they were sent; they
-- are forgotten after a fortnight.
UPDATE hooks
SET events = (
  SELECT json_group_array(CASE WHEN value LIKE 'issue.%' THEN 'work_item.' || substr(value, 7) ELSE value END)
  FROM json_each(hooks.events)
)
WHERE EXISTS (SELECT 1 FROM json_each(hooks.events) WHERE value LIKE 'issue.%');
