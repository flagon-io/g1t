-- Issues became work items (g1t #57), and the dataset `issues` is
-- `work_items` now (packages/contracts/src/datasets.ts). A dashboard's
-- tiles are kept in its Yjs document, which no dashboard has yet (the kind
-- is not built: kinds/index.ts); a workspace's dashboard templates keep
-- theirs as JSON (`{ tiles: [{ query: { dataset } }] }`), rewritten here.
UPDATE folio_templates
SET body = json_set(body, '$.tiles', (
  SELECT json_group_array(json(tile)) FROM (
    SELECT CASE WHEN json_extract(t.value, '$.query.dataset') = 'issues'
             THEN json_set(t.value, '$.query.dataset', 'work_items')
             ELSE t.value END AS tile
    FROM json_each(folio_templates.body, '$.tiles') t
    ORDER BY t.key
  )
))
WHERE kind = 'dashboard' AND json_valid(body) AND json_type(body, '$.tiles') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(folio_templates.body, '$.tiles') t WHERE json_extract(t.value, '$.query.dataset') = 'issues');
