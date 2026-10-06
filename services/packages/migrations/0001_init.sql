-- Packages: the registries beside the code (docs/PACKAGES.md). Times are
-- RFC 3339 text, sizes bytes.

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- container, npm, composer, cargo, go.
  ecosystem TEXT NOT NULL,
  -- Normalized per ecosystem; for a container image, the name after the
  -- workspace (`web/api` for g1t.sh/acme/web/api).
  name TEXT NOT NULL,
  -- The repository it is linked to, and its name as it is now (kept by
  -- repo.renamed). A linked package has its repository's visibility.
  repo_id TEXT,
  repo_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  description TEXT,
  readme_digest TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace, ecosystem, name)
);
CREATE INDEX packages_workspace ON packages (workspace, updated_at);
CREATE INDEX packages_repo ON packages (repo_id);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  -- A tag, semver or, for a container image, its manifest's digest.
  version TEXT NOT NULL,
  -- The manifest's or the archive's digest.
  digest TEXT NOT NULL,
  -- Bytes of its files.
  size INTEGER NOT NULL,
  -- What the ecosystem needs: for a container image its media type,
  -- artifact type, annotations and platforms.
  metadata TEXT NOT NULL DEFAULT '{}',
  -- For an OCI artifact: the digest of the manifest it is about.
  subject TEXT,
  published_by TEXT,
  published_at TEXT NOT NULL,
  yanked INTEGER NOT NULL DEFAULT 0,
  deprecated TEXT,
  UNIQUE (package_id, version)
);
CREATE INDEX versions_digest ON versions (package_id, digest);
CREATE INDEX versions_subject ON versions (package_id, subject) WHERE subject IS NOT NULL;
CREATE INDEX versions_published ON versions (package_id, published_at);

CREATE TABLE version_files (
  version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  -- `manifest`, `config`, `layer:<n>`; a file name for other ecosystems.
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT,
  PRIMARY KEY (version_id, name)
);
-- The sweep asks whether any version still uses a blob.
CREATE INDEX version_files_digest ON version_files (digest);

-- Every file kept, once, by digest. `object_key` is where it is in the
-- store: blobs/sha256/<hex> when stored whole, blobs/parts/<upload> when it
-- came in parts. `touched_at` moves when a push finds it already there, so
-- the sweep spares a blob a push in flight is about to use.
CREATE TABLE blobs (
  digest TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  media_type TEXT,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL
);
CREATE INDEX blobs_touched ON blobs (touched_at);

-- Which blobs each package may serve: uploaded or mounted into it, or named
-- by its manifests. A digest alone never reads another package's blob.
CREATE TABLE package_blobs (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, digest)
);
CREATE INDEX package_blobs_digest ON package_blobs (digest);

-- What a workspace stores, each blob once, and whether any public package
-- uses it: what billing measures.
CREATE TABLE workspace_blobs (
  workspace TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, digest)
);

-- Uploads in progress: the multipart upload, its parts, how far it is,
-- the SHA-256 state so far, and the bytes in its tail (src/upload.rs).
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  package_id TEXT NOT NULL,
  -- The image name it was started for, `workspace/name`.
  package TEXT NOT NULL,
  multipart_id TEXT,
  parts TEXT NOT NULL DEFAULT '[]',
  "offset" INTEGER NOT NULL DEFAULT 0,
  tail INTEGER NOT NULL DEFAULT 0,
  hash_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX uploads_expires ON uploads (expires_at);

-- Container tags and npm dist-tags.
CREATE TABLE tags (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, tag)
);
CREATE INDEX tags_version ON tags (version_id);
