-- A proposal the guardrail applied as a rise waits for its notice as a
-- price version; a newer measurement before that date replaces the
-- version (src/pricing.rs, schedule_version). The proposal behind the
-- replaced version never took effect, but stayed "applied" with no date it
-- is in force from: sandbox_second and build_second's rises of 2026-10-07
-- (v2, due 2026-10-21) were replaced by v3 (due 2026-10-22) on 2026-10-08.
-- Nothing was charged at v2. From now on the replacement marks them
-- superseded; these are the ones from before.
UPDATE price_proposals SET status = 'superseded'
WHERE status = 'applied' AND version_id IS NOT NULL
  AND version_id NOT IN (SELECT id FROM price_versions);
