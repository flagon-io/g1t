-- Credits g1t staff give a workspace from sudo: promotional, goodwill or a
-- refund, each with a note, who gave it, and an optional expiry.
--
-- A grant is a ledger entry (kind top_up, reference `crd…`, so it is never
-- a payment) with `ledger.credit_kind` set; what expires or is revoked
-- unused is another, negative, with the same kind and the reference
-- `<grant>_expired` or `<grant>_revoked`. How much of a grant was used is
-- not stored: it is worked out from the ledger in order (grants.rs), the
-- soonest-expiring grant first, so it is always what the ledger says.
ALTER TABLE ledger ADD COLUMN credit_kind TEXT;

CREATE TABLE IF NOT EXISTS credit_grants (
  -- `crd_…`: the grant's ledger reference.
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- promotional, goodwill or refund (staff); purchased (paid for, by the
  -- workspace: cash, not given).
  kind TEXT NOT NULL,
  -- What it pays for: all usage, or models only (agent runs' model cost).
  -- Scoped credit is spent before credit for everything.
  scope TEXT NOT NULL DEFAULT 'all',
  -- Where it came from: staff (sudo), purchase, or promo_code.
  source TEXT NOT NULL DEFAULT 'staff',
  amount_micros INTEGER NOT NULL,
  note TEXT NOT NULL,
  -- A refund: what it refunds, and the day whose money it gives back.
  refund_for TEXT,
  refund_day TEXT,
  -- RFC 3339; null never expires.
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Expired or revoked: when, why, and what was taken off the balance.
  closed_at TEXT,
  closed_reason TEXT,
  closed_note TEXT,
  closed_by TEXT,
  closed_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS credit_grants_by_workspace ON credit_grants (workspace, created_at);
CREATE INDEX IF NOT EXISTS credit_grants_open ON credit_grants (closed_at, expires_at);
CREATE INDEX IF NOT EXISTS credit_grants_by_month ON credit_grants (created_at);

-- Spent credit, by kind: given away (promotional, goodwill). A refund's
-- use is not given: it gives back money already paid, and takes it off
-- cash on the day it refunds instead.
ALTER TABLE margin_days ADD COLUMN given_credit_promotional_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_days ADD COLUMN given_credit_goodwill_micros INTEGER NOT NULL DEFAULT 0;

-- Credits from g1t until now were all "a refund or goodwill" by the form's
-- word, with no way to tell which: goodwill, which counts as given and so
-- never as money in. None expire.
UPDATE ledger SET credit_kind = 'goodwill'
 WHERE kind = 'top_up' AND reference LIKE 'crd%' AND amount_micros > 0 AND description LIKE 'Credit from g1t:%'
   AND credit_kind IS NULL;
INSERT OR IGNORE INTO credit_grants (id, workspace, kind, amount_micros, note, created_by, created_at)
SELECT reference, workspace, 'goodwill', amount_micros,
       TRIM(substr(description, length('Credit from g1t:') + 1)),
       COALESCE(created_by, 'g1t'), created_at
  FROM ledger
 WHERE kind = 'top_up' AND reference LIKE 'crd%' AND amount_micros > 0 AND description LIKE 'Credit from g1t:%';
