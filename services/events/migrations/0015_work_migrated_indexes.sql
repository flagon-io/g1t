-- Rewriting the log for a page of `work.migrated` (src/work_items.rs
-- `MOVED`) finds each of the page's issues' events by its repository and
-- old number, instead of reading every event of the page's repositories
-- once per statement: a large repository's log took longer than D1 allows,
-- and the page was retried for ever. Each index holds only the events the
-- rewrite looks for, which events written since no longer are (they name
-- work items), but for comments.
CREATE INDEX IF NOT EXISTS events_issue_number ON events (repo_id, json_extract(data, '$.number'))
  WHERE type IN ('issue.opened', 'issue.updated', 'issue.assigned', 'issue.labeled', 'issue.unlabeled', 'issue.milestoned',
                 'issue.demilestoned', 'issue.closed', 'issue.reopened', 'comment.created', 'comment.edited', 'comment.deleted');
CREATE INDEX IF NOT EXISTS events_issue ON events (repo_id, json_extract(data, '$.issue'))
  WHERE json_extract(data, '$.issue') IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_other_issue ON events (repo_id, json_extract(data, '$.otherIssue'))
  WHERE json_extract(data, '$.otherIssue') IS NOT NULL;
