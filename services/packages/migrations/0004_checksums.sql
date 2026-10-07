-- The checksums Maven asks for beside every file (`.md5`, `.sha1`,
-- `.sha512`; `.sha256` is the blob's digest), worked out once when the
-- file is uploaded so a download never reads a file twice. Kept by digest,
-- as blobs are, and let go with them.
CREATE TABLE checksums (
  digest TEXT PRIMARY KEY,
  md5 TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  sha512 TEXT NOT NULL
);
