-- Freeze an invoice's customer and lines before contacting Stripe. Concurrent
-- callers and retries use the same attempt even when more usage arrives.
CREATE TABLE invoice_attempts (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  invoice_id TEXT
);

-- Continue bounded replay across ticks instead of repeatedly reading the
-- newest 1,000 events and starving an older backlog.
ALTER TABLE stripe_sync ADD COLUMN replay_after TEXT;
ALTER TABLE stripe_sync ADD COLUMN replay_since INTEGER;
ALTER TABLE stripe_sync ADD COLUMN replay_until INTEGER;
ALTER TABLE stripe_sync ADD COLUMN replay_failed INTEGER;

-- Keep the card that funded a trial even if the workspace changes cards.
ALTER TABLE trial_grants ADD COLUMN fingerprint TEXT;
UPDATE trial_grants SET fingerprint = (
  SELECT c.fingerprint FROM card_checks c WHERE c.workspace = trial_grants.workspace
    AND c.fingerprint IS NOT NULL AND c.workspace = (
      SELECT MIN(other.workspace) FROM card_checks other JOIN trial_grants g ON g.workspace = other.workspace
      WHERE other.fingerprint = c.fingerprint
    )
);
CREATE UNIQUE INDEX trial_grants_by_fingerprint ON trial_grants(fingerprint) WHERE fingerprint IS NOT NULL;
