INSERT OR IGNORE INTO purge_jobs (subject_id, kind, target, payload, created_at, retry_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?5
WHERE (?2 = 'user' AND EXISTS (
  SELECT 1 FROM users WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after IS NOT NULL
)) OR (?2 = 'workspace' AND EXISTS (
  SELECT 1 FROM workspaces WHERE id = ?1 AND deleted_at IS NOT NULL AND purge_after IS NOT NULL
))
