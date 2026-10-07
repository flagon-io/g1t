-- What each workspace's usage was priced at (cost plus 20%), whoever paid
-- for it: the trial, a gift, the plan's included usage or a card. The
-- cost-over-revenue alert compares cost with this, so a giveaway is not
-- mistaken for a price below cost; revenue_micros stays the cash paid.
ALTER TABLE workspace_costs ADD COLUMN value_micros INTEGER NOT NULL DEFAULT 0;
