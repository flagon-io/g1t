-- What agents cost, charged to the workspace they worked for.
-- Money is in millionths of a US dollar. Every timestamp is RFC 3339 UTC.

CREATE TABLE accounts (
  -- The workspace's slug.
  workspace TEXT PRIMARY KEY,
  -- Credit left. Always the sum of the workspace's ledger.
  balance_micros INTEGER NOT NULL DEFAULT 0,
  -- The payment provider's customer, once the workspace has paid once.
  customer_id TEXT,
  created_at TEXT NOT NULL
);

-- Every change to a balance: credit bought, and each agent run.
CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- top_up or usage.
  kind TEXT NOT NULL,
  -- Positive for credit added, negative for usage.
  amount_micros INTEGER NOT NULL,
  description TEXT NOT NULL,
  -- For usage: what the agent worked on, and what the provider charged
  -- before g1t's margin.
  repo TEXT,
  number INTEGER,
  task TEXT,
  model TEXT,
  cost_micros INTEGER,
  -- The payment or the run this entry is for. Unique, so neither can be
  -- entered twice.
  reference TEXT NOT NULL UNIQUE,
  -- For a top-up: the username of whoever paid.
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ledger_by_workspace ON ledger (workspace, id);

-- Agent runs that have started. A run is charged when its sandbox reports
-- what it cost, once.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  -- SHA-256 of the token the sandbox reports with.
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- Card payments that have been started. Credited when the provider says
-- the payment was made, once.
CREATE TABLE checkouts (
  -- The provider's id for the payment page.
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  -- open or paid.
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX checkouts_by_workspace ON checkouts (workspace, status);
