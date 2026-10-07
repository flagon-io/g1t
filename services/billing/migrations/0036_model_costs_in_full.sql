-- Model costs counted in full, and margin kept on every sale.
--
-- What a discount on an account's terms took below cost plus the margin:
-- counted as given (why "discount"), so a discounted sale is valued at its
-- price and never reads as margin lost. Negative on a correction down.
ALTER TABLE ledger ADD COLUMN discount_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_days ADD COLUMN given_discount_micros INTEGER NOT NULL DEFAULT 0;

-- Why a run was settled at no less than the sandbox reported instead of
-- at AI Gateway's figure: a model the gateway has no price for, or more
-- logs than were read. Null when the gateway's figure was the whole cost.
ALTER TABLE runs ADD COLUMN gateway_note TEXT;

-- AI Gateway's analytics (cost_lines source ai_gateway): what the gateway
-- priced g1t's own provider traffic at, per day and model. Its cost is the
-- models bucket's "Cloudflare" side, checked against the ledger's model
-- cost (which stays the bucket's cost).
INSERT OR IGNORE INTO cost_map (product, meter, bucket, price_meter, own_meter, scale_to_own, note, updated_at, updated_by) VALUES
  ('ai_gateway_requests', '*', 'models', NULL, NULL, 0, 'What AI Gateway priced g1t''s own model traffic at, per model', '2026-10-07T00:00:00Z', 'migration');
