-- Complimentary and custom terms that g1t staff enroll a workspace in from
-- sudo (src/complimentary.rs). New workspaces stay free; nothing here
-- enrolls anyone.
--
-- An enrollment gives the plan's features, a monthly usage allowance valued
-- at ordinary usage prices, and a recurring monthly fee of its own (zero:
-- waived). The fee and the allowance are separate amounts. There is no
-- rollover. Past the allowance (`overage`): `stop`, new billable work stops
-- and what work already running costs past it is g1t's
-- (`ledger.given_micros`), never charged to the workspace afterwards; or
-- `charge`, g1t covers the allowance and usage past it is charged to the
-- workspace's own card at ordinary prices, under its limits, as on the plan
-- (employees, friends). Without a card, `charge` stops as `stop` does.
--
-- A real Stripe customer and subscription represent the enrollment. The
-- workspace sees it only once Stripe has the subscription (`status`
-- `active`); until then it is `pending` and the workspace keeps its plan.
CREATE TABLE IF NOT EXISTS complimentary (
  workspace TEXT PRIMARY KEY,
  -- `cmp_…`: the grant's identity, in the Stripe subscription's metadata and
  -- every idempotency key for it, so a retry never makes a second one.
  grant_id TEXT NOT NULL UNIQUE,
  -- pending: Stripe not confirmed yet; active; ended.
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'ended')),
  -- The current terms; their history is `complimentary_periods`.
  allowance_micros INTEGER NOT NULL CHECK (allowance_micros >= 0),
  unlimited INTEGER NOT NULL DEFAULT 0 CHECK (unlimited IN (0, 1)),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  overage TEXT NOT NULL DEFAULT 'stop' CHECK (overage IN ('stop', 'charge')),
  -- Whether the Stripe objects below are live-mode objects: test objects
  -- are never carried into live mode.
  live INTEGER NOT NULL DEFAULT 0 CHECK (live IN (0, 1)),
  customer_id TEXT,
  subscription_id TEXT UNIQUE,
  -- The subscription's one item and the price it has while complimentary:
  -- a different price on that item means the owner converted to the plan.
  item_id TEXT,
  price_id TEXT,
  -- What Stripe last said about the subscription.
  stripe_status TEXT,
  -- A Stripe operation still owed, as JSON: {"op":"create"|"terms"|"cancel"|"convert", ...}.
  -- Kept until done, so a crash or an error is picked up by the next tick
  -- with the same idempotency key.
  pending_op TEXT,
  last_error TEXT,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- How it ended: revoked (staff), converted (the owner started the plan).
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IS NULL OR ended_reason IN ('revoked', 'converted')),
  -- The plan subscription a conversion produced (the same subscription id).
  converted_at TEXT
);
CREATE INDEX IF NOT EXISTS complimentary_pending ON complimentary (pending_op) WHERE pending_op IS NOT NULL;

-- The terms over time. A usage line draws on the period that covers its own
-- time, so late usage lands in the period it happened in, and changing the
-- amount closes one period and opens the next without touching what was
-- used: consumption is per calendar month (`allowance_use`, kind
-- `complimentary`), whatever the periods in it.
CREATE TABLE IF NOT EXISTS complimentary_periods (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  -- RFC 3339; null `ends_at`: open.
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  allowance_micros INTEGER NOT NULL CHECK (allowance_micros >= 0),
  unlimited INTEGER NOT NULL DEFAULT 0 CHECK (unlimited IN (0, 1)),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  overage TEXT NOT NULL DEFAULT 'stop' CHECK (overage IN ('stop', 'charge')),
  note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS complimentary_periods_by_workspace ON complimentary_periods (workspace, starts_at);
-- At most one open period per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS complimentary_periods_open ON complimentary_periods (workspace) WHERE ends_at IS NULL;

-- What a complimentary allowance paid of a usage line: promotional, never
-- money in. Separate from `given_micros`, which is what g1t covered past
-- every allowance (a complimentary workspace's overrun included).
ALTER TABLE ledger ADD COLUMN gift_micros INTEGER NOT NULL DEFAULT 0;

-- Payments a workspace made outside Stripe (a bank transfer, a cheque)
-- recorded by staff are money received; they were already ledger top-ups
-- with `credit_kind` null. Nothing to migrate: promotional credit keeps
-- `credit_kind = 'promotional'`, and a complimentary allowance is never a
-- ledger top-up at all.
