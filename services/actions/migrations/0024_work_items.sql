-- Work items: runs that issues and their comments started name the events
-- that start them now, `work_item` and `work_item_comment`, and their
-- payload (`info.event`) has the item in `work_item`, where `issue` was.
-- A workflow's listed events stay as its file names them: a file that
-- still says `issues` starts nothing until it says `work_item`.
UPDATE runs
SET info = json_remove(json_set(info, '$.event.work_item', json(json_extract(info, '$.event.issue'))), '$.event.issue')
WHERE event IN ('issues', 'issue_comment') AND json_type(info, '$.event.issue') IS NOT NULL;

UPDATE runs
SET event = CASE event WHEN 'issues' THEN 'work_item' ELSE 'work_item_comment' END,
    info = json_set(info, '$.eventName', CASE event WHEN 'issues' THEN 'work_item' ELSE 'work_item_comment' END)
WHERE event IN ('issues', 'issue_comment');
