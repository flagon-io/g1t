-- Models at the provider's price; Security and quality with no price of
-- its own.
--
-- The price book after this migration:
--
-- - Agent models (`agent_models`): the provider's price, no markup. The
--   version that says so (pv_agent_models_2) took effect on 2026-10-08;
--   if the daily run has not put it in force yet, it is put in force here.
--   A fall, so it applies at once.
-- - The g1t agent rate (`agent_tokens`, `agent_tokens_own`): unchanged.
--   $0.25 per million tokens from 2026-10-22, already announced, for what
--   g1t runs around every model call (the model gateway, secrets, routing,
--   context, pass-through to your own provider), on your own keys too.
-- - Security and quality activation (`security_activation`): $0, in force
--   now. It comes with the g1t plan; its scans stay metered at cost plus
--   20% (`scan_cpu`, `scan_rows`). A fall, so it applies at once. Billing's
--   daily run ends the activation subscriptions at Stripe and archives
--   the product (features.rs `retire_security_activations`).
-- - Everything else g1t runs stays at cost plus 20%, as it already is.

-- 1. Models with no markup, in force now.
INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, old_markup_percent, reason, created_at)
SELECT 'prc_agent_models_at_cost', meter, cost_micros, cost_micros, 0, markup_percent,
       'Lower: models at the provider''s price, with no markup',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM prices WHERE meter = 'agent_models' AND markup_percent <> 0;

UPDATE price_versions SET applied_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 'pv_agent_models_2' AND applied_at IS NULL;

UPDATE prices SET markup_percent = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE meter = 'agent_models' AND markup_percent <> 0;

-- 2. Security and quality: no price of its own. Anything waiting for it
-- is replaced, as pricing.rs does when a newer decision replaces a
-- waiting version.
UPDATE price_proposals SET status = 'superseded'
 WHERE version_id IN (SELECT id FROM price_versions WHERE meter = 'security_activation' AND applied_at IS NULL);

DELETE FROM price_versions WHERE meter = 'security_activation' AND applied_at IS NULL;

INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
SELECT 'prc_security_activation_none', meter, cost_micros, 0, 0,
       'Lower: Security and quality comes with the g1t plan, with no monthly price; its scans are charged at cost plus 20%',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM prices WHERE meter = 'security_activation' AND cost_micros > 0;

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at)
SELECT 'pv_security_activation_' || (COALESCE(MAX(version), 0) + 1), 'security_activation', COALESCE(MAX(version), 0) + 1, 0, 0,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       'Security and quality comes with the g1t plan, with no monthly price', 'migration',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM price_versions WHERE meter = 'security_activation';

UPDATE prices SET cost_micros = 0, markup_percent = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE meter = 'security_activation' AND cost_micros <> 0;
