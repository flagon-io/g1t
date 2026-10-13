-- The standard sandbox is now Cloudflare Containers' standard-3: 2 vCPU,
-- 8 GiB of memory and 16 GB of disk, where it had half a vCPU, 4 GiB and
-- 8 GB (standard-1; a custom 1 vCPU, 4 GiB, 20 GB type was never served).
-- Cloudflare bills memory and disk as provisioned for every second a
-- container runs, so a sandbox second's base (memory, disk and the Durable
-- Object behind it) is now, at list prices:
--
--   8 x 2.5 + 16 x 0.07 + 0.125 x 12.5 = 22.6825 millionths of a dollar
--
-- against 12.1225 for 4 GiB and 8 GB. g1t-4core (standard-4) is priced
-- from it by its scale in the contracts. The price book follows it now,
-- not after the keeper's notice period, so g1t never charges less than a
-- sandbox costs it:
--
-- - sandbox_base_second (runs that report their own CPU): 22.6825.
-- - sandbox_second and build_second (the average, for runs that do not):
--   what they were, or a rise still waiting for its date if that is more,
--   plus 10.56, the base's growth from 12.1225. The CPU in use on top of
--   the base is unchanged, and counting it from the smallest base the
--   price book had keeps the result at or above cost.
--
-- Rises still waiting for their date on these meters are replaced, as
-- pricing.rs does when a newer decision replaces a waiting version, so
-- none can take the price below cost later. The keeper measures again on
-- its daily run.

-- 1. What changes, and why.
INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
SELECT 'prc_standard_3_' || meter, meter, cost_micros,
       CASE meter
         WHEN 'sandbox_base_second' THEN MAX(cost_micros, 22.6825,
           COALESCE((SELECT MAX(v.cost_micros) FROM price_versions v WHERE v.meter = prices.meter AND v.applied_at IS NULL), 0))
         ELSE MAX(cost_micros,
           COALESCE((SELECT MAX(v.cost_micros) FROM price_versions v WHERE v.meter = prices.meter AND v.applied_at IS NULL), 0)) + 10.56
       END,
       markup_percent,
       'Higher: the standard sandbox is now 2 vCPU, 8 GiB and 16 GB, and Cloudflare bills its memory and disk for every second it runs',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM prices WHERE meter IN ('sandbox_base_second', 'sandbox_second', 'build_second');

-- 2. The price book, now.
UPDATE prices
   SET cost_micros = (SELECT c.new_cost_micros FROM price_changes c WHERE c.id = 'prc_standard_3_' || prices.meter),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE meter IN ('sandbox_base_second', 'sandbox_second', 'build_second')
   AND EXISTS (SELECT 1 FROM price_changes c WHERE c.id = 'prc_standard_3_' || prices.meter);

-- 3. Rises waiting for their date are replaced.
UPDATE price_proposals SET status = 'superseded'
 WHERE version_id IN (SELECT id FROM price_versions
                       WHERE meter IN ('sandbox_base_second', 'sandbox_second', 'build_second') AND applied_at IS NULL);

DELETE FROM price_versions
 WHERE meter IN ('sandbox_base_second', 'sandbox_second', 'build_second') AND applied_at IS NULL;

-- 4. A version in force from now, so the charges after it are explained by
-- it.
INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at)
SELECT 'pv_' || p.meter || '_' || (COALESCE((SELECT MAX(v.version) FROM price_versions v WHERE v.meter = p.meter), 0) + 1),
       p.meter,
       COALESCE((SELECT MAX(v.version) FROM price_versions v WHERE v.meter = p.meter), 0) + 1,
       p.cost_micros, p.markup_percent,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       'The standard sandbox is now 2 vCPU, 8 GiB and 16 GB', 'migration',
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM prices p WHERE p.meter IN ('sandbox_base_second', 'sandbox_second', 'build_second');
