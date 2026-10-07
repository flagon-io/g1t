-- What was given away, by why: comped workspaces, free use (free periods,
-- free allowances, overruns g1t covered), the trial and the open-source
-- pool. given_micros stays their total.
ALTER TABLE margin_days ADD COLUMN given_comped_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_days ADD COLUMN given_free_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_days ADD COLUMN given_trial_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_days ADD COLUMN given_pool_micros INTEGER NOT NULL DEFAULT 0;
