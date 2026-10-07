-- Each version's own downloads, beside its package's: NuGet's registration
-- and search name them. Counted the way the package's are, approximately.
ALTER TABLE versions ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0;

-- The NuGet symbol server finds a PDB by the name a version keeps it under
-- (`pdb:<file>:<key>`), across a workspace's packages.
CREATE INDEX version_files_name ON version_files (name);
