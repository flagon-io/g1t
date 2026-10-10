-- Artifacts mode, Phase 2 (docs/ARTIFACTS_MODE.md section 12).
--
-- "Editors can share": a space setting that lets people with edit access
-- share what is in the space, as people with full access can. Off unless
-- a space's managers turn it on.
ALTER TABLE spaces ADD COLUMN editors_can_share INTEGER NOT NULL DEFAULT 0;

-- Access requests, one row per person and folio: when they last asked.
-- A person asks again for the same folio at most once a day.
CREATE TABLE folio_access_requests (
  folio_id TEXT NOT NULL REFERENCES folios (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (folio_id, user_id)
);
