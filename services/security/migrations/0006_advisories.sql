-- Reporting (src/advisories.rs): a repository's security advisories, and
-- the vulnerability reports people send its maintainers privately.

-- An advisory: what the repository says about a vulnerability in what it
-- ships. Drafts are the maintainers'; published ones anyone who can see
-- the repository reads.
--   state: draft | published | withdrawn
--   severity: critical | high | medium | low
--   credits: JSON array of strings
CREATE TABLE security_advisories (
  id TEXT PRIMARY KEY,
  g1tsa_id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  cvss_vector TEXT,
  cvss_score REAL,
  cve_id TEXT,
  ecosystem TEXT,
  package TEXT,
  affected_versions TEXT,
  patched_versions TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  credits TEXT NOT NULL DEFAULT '[]',
  report_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  withdrawn_at TEXT
);
CREATE INDEX security_advisories_repo ON security_advisories (repo_id, state, created_at);

-- A report: what someone told the maintainers privately, when the
-- repository takes private vulnerability reports. The reporter is a
-- username when signed in, else the address they gave; reporter_key is
-- either, lowercased, for the limit on how many one person files a day.
--   state: new | accepted | declined
CREATE TABLE vulnerability_reports (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  reporter TEXT,
  reporter_email TEXT,
  reporter_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  advisory_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX vulnerability_reports_repo ON vulnerability_reports (repo_id, state, created_at);
CREATE INDEX vulnerability_reports_reporter ON vulnerability_reports (repo_id, reporter_key, created_at);
