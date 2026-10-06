-- The tier g1t routed a run to on its hosted models, small or large, so
-- what the model cost can be read per tier. Null on a workspace's own
-- provider, and for runs from before routing by tier.
ALTER TABLE runs ADD COLUMN tier TEXT;
