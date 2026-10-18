-- Issues became work items (g1t #57): cards kept about one are about a
-- work item now, and a draft of one is a draft work item.
UPDATE messages SET card = json_set(card, '$.kind', 'work_item')
WHERE kind = 'card' AND json_valid(card) AND json_extract(card, '$.kind') = 'issue';

UPDATE messages SET card = json_set(card, '$.kind', 'draft_work_item')
WHERE kind = 'card' AND json_valid(card) AND json_extract(card, '$.kind') = 'draft_issue';
