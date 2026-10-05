-- Custom domains: a project's production at a hostname of its own. Each is
-- a Cloudflare for SaaS custom hostname on the g1t.page zone; the
-- dispatcher finds its app in the g1t-domains KV namespace. See
-- src/domains.ts.
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- Lowercase, punycode.
  hostname TEXT NOT NULL UNIQUE,
  -- What it serves: production (a branch, later).
  target TEXT NOT NULL DEFAULT 'production',
  -- Cloudflare's id for it; null until Cloudflare has it.
  cf_hostname_id TEXT,
  -- pending, verifying, active, failed or removing.
  status TEXT NOT NULL,
  -- Cloudflare's state for its certificate, as given.
  ssl_status TEXT,
  -- A JSON array of the records Cloudflare asks for: ownership, and any
  -- the certificate's validation needs.
  records TEXT NOT NULL DEFAULT '[]',
  -- For a www/apex pair: the hostname this one redirects to.
  redirect_to TEXT,
  -- The script its KV entry names, to rewrite it only when that changes.
  script TEXT,
  -- Why it is not active, or failed.
  error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  checked_at TEXT
);
CREATE INDEX domains_by_project ON domains (project_id);
CREATE INDEX domains_by_workspace ON domains (workspace);
CREATE INDEX domains_by_status ON domains (status, checked_at);

-- The most custom domains the workspace had at once this month, charged
-- past the plan's once the month is over.
ALTER TABLE meters ADD COLUMN peak_domains INTEGER NOT NULL DEFAULT 0;
