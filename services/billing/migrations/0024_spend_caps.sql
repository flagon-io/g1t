-- What g1t pays for itself, and the two caps on it (src/budget.rs).
--
-- g1t_spend: at cost, by day, what paid (comped, trial, oss, given,
-- unpaid) and billing account, added to as work settles. The daily
-- breaker reads today's total; a comped account's monthly budget reads its
-- month's comped rows.
CREATE TABLE IF NOT EXISTS g1t_spend (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  account TEXT NOT NULL,
  micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket, account)
);
CREATE INDEX IF NOT EXISTS g1t_spend_by_account ON g1t_spend (account, bucket, day);

-- The daily breaker: when it tripped and staff were told, and a lift for
-- the rest of the day.
CREATE TABLE IF NOT EXISTS spend_breaker (
  day TEXT PRIMARY KEY,
  tripped_at TEXT,
  tripped_micros INTEGER,
  told_at TEXT,
  lifted_by TEXT,
  lifted_at TEXT,
  lift_note TEXT
);

-- Comped budgets' 50, 75, 90 and 100% alerts, once each a month.
CREATE TABLE IF NOT EXISTS budget_alerts (
  account TEXT NOT NULL,
  month TEXT NOT NULL,
  level INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (account, month, level)
);

-- This month so far, from the ledger, so the caps start from what was
-- already spent. Billing takes no real money yet (Stripe's test key), so
-- what no trial, pool or g1t itself paid is 'unpaid'. Usage on a
-- workspace's own model provider costs g1t nothing and is left out.
INSERT OR IGNORE INTO g1t_spend (day, bucket, account, micros)
SELECT substr(l.created_at, 1, 10), 'comped', COALESCE(m.account_id, 'ws_' || l.workspace), SUM(l.cost_micros)
FROM ledger l
LEFT JOIN account_members m ON m.workspace = l.workspace
JOIN billing_accounts b ON b.id = COALESCE(m.account_id, 'ws_' || l.workspace)
WHERE l.kind = 'usage' AND COALESCE(l.billed_to, 'g1t') = 'g1t' AND l.cost_micros > 0
  AND l.created_at >= strftime('%Y-%m-01', 'now') AND b.terms_kind = 'comped'
GROUP BY 1, 3;

INSERT OR IGNORE INTO g1t_spend (day, bucket, account, micros)
SELECT r.day, k.bucket, r.account,
       SUM(CASE
             WHEN k.bucket = 'unpaid' THEN r.cost - CASE WHEN r.gross > 0 THEN (r.cost * r.trial / r.gross) + (r.cost * r.oss / r.gross) + (r.cost * r.given / r.gross) ELSE 0 END
             WHEN r.gross <= 0 THEN 0
             WHEN k.bucket = 'trial' THEN r.cost * r.trial / r.gross
             WHEN k.bucket = 'oss' THEN r.cost * r.oss / r.gross
             ELSE r.cost * r.given / r.gross
           END) AS micros
FROM (
  SELECT substr(l.created_at, 1, 10) AS day, COALESCE(m.account_id, 'ws_' || l.workspace) AS account,
         l.cost_micros AS cost,
         -l.amount_micros + COALESCE(l.credit_micros, 0) + COALESCE(l.trial_micros, 0) + COALESCE(l.oss_micros, 0) + COALESCE(l.given_micros, 0) AS gross,
         COALESCE(l.trial_micros, 0) AS trial, COALESCE(l.oss_micros, 0) AS oss, COALESCE(l.given_micros, 0) AS given
  FROM ledger l
  LEFT JOIN account_members m ON m.workspace = l.workspace
  LEFT JOIN billing_accounts b ON b.id = COALESCE(m.account_id, 'ws_' || l.workspace)
  WHERE l.kind = 'usage' AND COALESCE(l.billed_to, 'g1t') = 'g1t' AND l.cost_micros > 0
    AND l.created_at >= strftime('%Y-%m-01', 'now') AND COALESCE(b.terms_kind, 'standard') <> 'comped'
) r
CROSS JOIN (SELECT 'trial' AS bucket UNION ALL SELECT 'oss' UNION ALL SELECT 'given' UNION ALL SELECT 'unpaid') k
GROUP BY r.day, k.bucket, r.account
HAVING SUM(CASE
             WHEN k.bucket = 'unpaid' THEN r.cost - CASE WHEN r.gross > 0 THEN (r.cost * r.trial / r.gross) + (r.cost * r.oss / r.gross) + (r.cost * r.given / r.gross) ELSE 0 END
             WHEN r.gross <= 0 THEN 0
             WHEN k.bucket = 'trial' THEN r.cost * r.trial / r.gross
             WHEN k.bucket = 'oss' THEN r.cost * r.oss / r.gross
             ELSE r.cost * r.given / r.gross
           END) > 0;
