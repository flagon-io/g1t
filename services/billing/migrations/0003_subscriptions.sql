-- Paid features a workspace turns on with a monthly plan (deployments).
-- Never free: FREE_WHILE_BUILDING does not cover them.

CREATE TABLE subscriptions (
  workspace TEXT NOT NULL,
  -- deployments.
  feature TEXT NOT NULL,
  -- The payment provider's subscription.
  subscription_id TEXT NOT NULL,
  -- active, canceling, past_due or canceled.
  status TEXT NOT NULL,
  -- When the period paid for ends; the plan is asked about again after.
  period_end TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, feature)
);

-- A card page for a plan rather than for credit.
ALTER TABLE checkouts ADD COLUMN feature TEXT;
