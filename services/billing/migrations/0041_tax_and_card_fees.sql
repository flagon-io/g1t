-- Stripe Tax on every payment, and the card processing fee on every card
-- payment.
--
-- Prices are shown and kept excluding tax. Stripe works the tax out on
-- every Checkout page, subscription, invoice and off-session charge
-- (`automatic_tax`, tax code `txcd_10103001`, tax behavior `exclusive`).
-- What reaches a workspace's balance is the payment less its tax and its
-- card fee; neither is revenue. Each is kept here, one row per payment and
-- kind, so the statement shows them as their own lines and sudo's Costs
-- shows tax collected apart from cash.

CREATE TABLE IF NOT EXISTS tax_and_fees (
  -- `<reference>/tax` or `<reference>/card_fee`. A refund's share is
  -- negative, under the refund's reference `refund/<charge>/<refunded>`.
  id TEXT PRIMARY KEY,
  -- The workspace, or for an enterprise's invoice its billing account.
  workspace TEXT NOT NULL,
  -- tax or card_fee.
  kind TEXT NOT NULL,
  -- Positive when collected, negative when refunded.
  amount_micros INTEGER NOT NULL,
  -- The payment: an invoice, a Checkout page or a PaymentIntent.
  reference TEXT NOT NULL,
  -- The PaymentIntent that took the money, so a refund finds its tax.
  payment_intent TEXT,
  -- Stripe Tax's transaction for an off-session charge (auto-reload),
  -- which a refund reverses.
  tax_transaction TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tax_and_fees_by_workspace ON tax_and_fees (workspace, created_at);
CREATE INDEX IF NOT EXISTS tax_and_fees_by_day ON tax_and_fees (created_at);
CREATE INDEX IF NOT EXISTS tax_and_fees_by_intent ON tax_and_fees (payment_intent);

-- A workspace invoice's card fee and tax, apart from the usage it pays for.
ALTER TABLE workspace_invoices ADD COLUMN fee_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_invoices ADD COLUMN tax_micros INTEGER NOT NULL DEFAULT 0;

-- Set when Stripe Tax could not work out where the customer is (no
-- billing address), so g1t did not charge: the Billing page asks an owner
-- for the address, and saving it clears this.
ALTER TABLE accounts ADD COLUMN tax_address_needed_at TEXT;

-- The card processing fee is on for every card payment, not only AI
-- credit: the setting's note says so. Never on invoiced or enterprise
-- payments, or bank transfers.
INSERT OR IGNORE INTO cost_settings (key, value, updated_at, updated_by) VALUES
  ('card_fee', 'on', '2026-10-08T00:00:00Z', 'migration');

INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_card_fee_all_cards', 'card_fee_percent', 29000, 29000, 0, 'Stripe''s card fee (2.9% + $0.30) is passed on as its own line on every card payment: the plan, Security and quality, prepaying, AI credit and invoices charged to a card. None on bank transfers or invoiced (enterprise) billing. Prices exclude tax; tax is added where it applies', '2026-10-08T00:00:00Z');
