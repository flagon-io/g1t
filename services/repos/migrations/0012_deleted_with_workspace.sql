-- deleted_with: the workspace (its id) a repository was deleted with, when
-- its owner deleted the whole workspace rather than the repository alone.
-- A restore of the workspace by g1t's staff brings back exactly the
-- repositories marked with it; one deleted on its own before stays in
-- Recently deleted, as it was. Null otherwise. See src/lifecycle.rs.
ALTER TABLE repos ADD COLUMN deleted_with TEXT;
CREATE INDEX IF NOT EXISTS repos_deleted_with ON repos (deleted_with) WHERE deleted_with IS NOT NULL;
