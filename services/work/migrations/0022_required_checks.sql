-- Checks are workflows, and the default branch's protection chooses which
-- of them must pass: for every pull request, a person's or an agent's.
-- Commands written on an issue are no longer run.

-- The checks that must pass before a pull request merges, by name (a
-- workflow's name, such as "CI", or another status's context): JSON array.
ALTER TABLE repo_settings ADD COLUMN required_checks TEXT NOT NULL DEFAULT '[]';

-- Until now every workflow reported on a pull request's head held its merge.
-- Repositories whose pull requests had workflows keep exactly that, made
-- visible: the workflows reported for pull_request events in the last 30
-- days become the default branch's required checks. Only where none are
-- set yet, so running this again changes nothing.
INSERT INTO repo_settings (repo_id, updated_by, updated_at, required_checks)
SELECT s.repo_id, 'g1t', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       json_group_array(DISTINCT substr(s.context, 1, length(s.context) - length(' / pull_request')))
FROM commit_statuses s
JOIN pulls p ON p.repo_id = s.repo_id AND p.head_commit = s.sha
WHERE s.context LIKE '% / pull_request'
  AND s.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
GROUP BY s.repo_id
ON CONFLICT (repo_id) DO UPDATE SET required_checks = excluded.required_checks
WHERE repo_settings.required_checks = '[]';

-- An issue's commands become words its agent and reviewers read: added to
-- its body under "Definition of done", once. The column is kept, as it
-- was, for the record; nothing reads it any more.
UPDATE issues
SET body = CASE WHEN trim(body) = '' THEN '' ELSE rtrim(body, ' ' || char(10) || char(13)) || char(10) || char(10) END
        || '## Definition of done' || char(10) || char(10)
        || (SELECT group_concat('- `' || replace(value, '`', '''') || '` passes.', char(10))
            FROM json_each(issues.checks) WHERE trim(value) != '')
WHERE checks != '[]'
  AND instr(body, '## Definition of done') = 0
  AND EXISTS (SELECT 1 FROM json_each(issues.checks) WHERE trim(value) != '');

-- What earlier runs of those commands said about open pull requests no
-- longer decides anything: their workflows do.
UPDATE pulls SET check_status = NULL, check_run_id = NULL
WHERE status IN ('draft', 'open') AND check_status IS NOT NULL;
