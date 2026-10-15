-- Native forks must snapshot their source's accounted bytes while new
-- writes are blocked. An interrupted copy retains its lock for explicit
-- reconciliation; expiring it blindly could admit an in-flight copy.
ALTER TABLE repos ADD COLUMN storage_reserved_bytes INTEGER NOT NULL DEFAULT 0;
CREATE TABLE storage_copy_locks (
    repo_id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
