-- A build stays 'ready' only while it is what its app serves. One a newer
-- build replaced becomes 'replaced'; one whose app was taken down becomes
-- 'down'. This corrects the builds already recorded.

-- Taken down: no app holds the script any more.
UPDATE deployments SET status = 'down'
WHERE status = 'ready' AND script NOT IN (SELECT script FROM apps);

-- Replaced: a later ready build of the same app exists.
UPDATE deployments SET status = 'replaced'
WHERE status = 'ready'
  AND EXISTS (
    SELECT 1 FROM deployments newer
    WHERE newer.script = deployments.script AND newer.status = 'ready'
      AND COALESCE(newer.finished_at, newer.created_at) > COALESCE(deployments.finished_at, deployments.created_at)
  );
