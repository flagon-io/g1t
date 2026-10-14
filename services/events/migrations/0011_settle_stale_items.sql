-- Settles inbox items that later events left with nothing to do, once, for
-- the items written before the inbox settled them as events arrive
-- (src/inbox.rs, "Settling"). Each is marked done, and read, as the event
-- would have marked it; it stays in Done with its history.

-- A workflow that failed on a branch and passed there since.
UPDATE inbox_items
SET done_at = COALESCE(done_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE done_at IS NULL
  AND thread LIKE '%/run/%'
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.repo_id = inbox_items.repo_id
      AND e.type = 'workflow.completed'
      AND e.id > inbox_items.event_id
      AND json_extract(e.data, '$.conclusion') = 'success'
      AND json_extract(e.data, '$.pull') IS NULL
      AND inbox_items.thread = e.repo_id || '/run/'
        || COALESCE(NULLIF(json_extract(e.data, '$.path'), ''), json_extract(e.data, '$.workflow'))
        || '@' || replace(json_extract(e.data, '$.ref'), 'refs/heads/', '')
  );

-- A deployment that failed and has succeeded since.
UPDATE inbox_items
SET done_at = COALESCE(done_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE done_at IS NULL
  AND event = 'deployment.failed'
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.repo_id = inbox_items.repo_id
      AND e.type = 'deployment.succeeded'
      AND e.id > inbox_items.event_id
      AND inbox_items.thread = e.repo_id || '/deploy/' || json_extract(e.data, '$.projectId') || '/'
        || COALESCE(CAST(json_extract(e.data, '$.number') AS TEXT), 'production')
  );

-- Anything about an issue or pull request that was merged or closed since
-- (or by the event the item last told of), and a pull request's previews.
UPDATE inbox_items
SET done_at = COALESCE(done_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE done_at IS NULL
  AND number IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.repo_id = inbox_items.repo_id
      AND e.type IN ('pull.merged', 'pull.closed', 'issue.closed')
      AND e.id >= inbox_items.event_id
      AND json_extract(e.data, '$.number') = inbox_items.number
      AND (inbox_items.thread = e.repo_id || '#' || inbox_items.number
        OR (e.type <> 'issue.closed' AND inbox_items.thread GLOB e.repo_id || '/deploy/*/' || inbox_items.number))
  );

-- Auto-merge g1t turned off because the merge queue took the pull request.
UPDATE inbox_items
SET done_at = COALESCE(done_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE done_at IS NULL
  AND event = 'pull.auto_merge_disabled'
  AND body = 'It joined the merge queue.';
